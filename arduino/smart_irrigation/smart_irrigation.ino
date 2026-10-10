/*
  Smart Irrigation System - Arduino UNO side (2 zones)
  -----------------------------------------------------
  Talks to the web dashboard (dashboard.html) over USB serial at 9600 baud.
  The learning and decisions happen in the dashboard. The Arduino reads the sensors,
  switches the relays and does the safety jobs that must work even if the laptop hangs.

  Browser -> Arduino :  ON1 | OFF1 | ON2 | OFF2 | ALLOFF | PING
  Arduino -> Browser :  DATA,<ldr>,<moist1 %>,<moist2 %>,<temp C>,<REAL|SIM>   every 1 s
                        PUMP1:ON | PUMP1:OFF | PUMP2:ON | PUMP2:OFF            on every change / command
                        WARN:<code>                                            safety cut-offs
                        INFO:<text>

  SAFETY
   - every pump switches off if the browser goes quiet for 5 s (tab closed, cable pulled)
   - one run can never be longer than 30 min
   - "offline care": if no browser has been connected for 1 min and a bed is very dry
     (< 20 %), water it for 60 s. At most once every 6 hours per bed.

  WIRING
    LDR + 10k divider        -> A0
    Soil moisture, zone 1    -> A1   (capacitive sensor v1.2, AOUT)
    LM35 temperature         -> A2   (VOUT, +5V, GND)
    Soil moisture, zone 2    -> A3
    Relay IN1 (pump 1)       -> D7
    Relay IN2 (pump 2)       -> D8   (relay VCC/GND to 5V/GND, pumps on their own supply)

  No sensors yet?  Leave USE_REAL_SENSORS = false. The sketch then sends simulated
  readings marked "SIM" and the dashboard shows "Simulated readings".
*/

// ---------- settings ----------
const int  PIN_LDR  = A0;
const int  PIN_TEMP = A2;
const int  PIN_MOIST[2] = { A1, A3 };
const int  PIN_RELAY[2] = { 7, 8 };
const bool RELAY_ACTIVE_LOW = true;    // most 5 V relay modules switch on LOW

const bool USE_REAL_SENSORS = false;   // true once the sensors are wired

// calibrate: note the raw analogRead() value with the sensor in dry air and in a glass of water
const int MOIST_DRY[2] = { 780, 780 };
const int MOIST_WET[2] = { 320, 320 };

const unsigned long PING_TIMEOUT_MS = 5000;
const unsigned long MAX_RUN_MS      = 30UL * 60UL * 1000UL;
const unsigned long OFFLINE_AFTER_MS = 60UL * 1000UL;
const int           OFFLINE_DRY_PCT  = 20;
const unsigned long OFFLINE_RUN_MS   = 60UL * 1000UL;
const unsigned long OFFLINE_GAP_MS   = 6UL * 60UL * 60UL * 1000UL;

// ---------- state ----------
bool          pumpOn[2]          = { false, false };
unsigned long pumpStarted[2]     = { 0, 0 };
bool          offlineRun[2]      = { false, false };
bool          offlineWatered[2]  = { false, false };
unsigned long lastOfflineWater[2] = { 0, 0 };
int           lastMoist[2]       = { 50, 50 };

unsigned long lastPing = 0;
unsigned long lastData = 0;
String        cmdBuffer = "";

// simulated sensors (USE_REAL_SENSORS = false)
float simMoist[2] = { 55.0, 50.0 };
float simLdr  = 600.0;
float simTemp = 26.5;

void setPump(int i, bool on) {
  if (on && !pumpOn[i]) pumpStarted[i] = millis();
  pumpOn[i] = on;
  if (!on) offlineRun[i] = false;

  bool level = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(PIN_RELAY[i], level ? HIGH : LOW);

  // always report, the browser waits for this as confirmation
  Serial.print("PUMP");
  Serial.print(i + 1);
  Serial.println(on ? ":ON" : ":OFF");
}

int readMoisture(int i) {
  int raw = analogRead(PIN_MOIST[i]);
  return constrain(map(raw, MOIST_DRY[i], MOIST_WET[i], 0, 100), 0, 100);
}

void readSensors(int &ldr, int moist[2], float &temp) {
  if (USE_REAL_SENSORS) {
    ldr  = analogRead(PIN_LDR);
    temp = analogRead(PIN_TEMP) * 500.0 / 1023.0;   // LM35: 10 mV per deg C
    for (int i = 0; i < 2; i++) moist[i] = readMoisture(i);
  } else {
    // moisture goes up while the pump runs and slowly dries otherwise
    for (int i = 0; i < 2; i++) {
      simMoist[i] += pumpOn[i] ? 1.2 : -0.12;
      simMoist[i] = constrain(simMoist[i], 5.0, 95.0);
      moist[i] = (int)simMoist[i];
    }
    simLdr  = constrain(simLdr + random(-20, 21), 50, 1000);
    simTemp = constrain(simTemp + random(-3, 4) / 10.0, 18.0, 38.0);
    ldr  = (int)simLdr;
    temp = simTemp;
  }
}

void handleCommand(String c) {
  c.trim();
  if (c.length() == 0) return;
  lastPing = millis();                 // any message means the browser is alive

  if      (c == "ON1")    setPump(0, true);
  else if (c == "OFF1")   setPump(0, false);
  else if (c == "ON2")    setPump(1, true);
  else if (c == "OFF2")   setPump(1, false);
  else if (c == "ALLOFF") { setPump(0, false); setPump(1, false); }
  else if (c == "PING")   { /* keep-alive only */ }
}

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 2; i++) {
    pinMode(PIN_RELAY[i], OUTPUT);
    setPump(i, false);
  }
  randomSeed(analogRead(A5));          // A5 is left floating, gives some noise
  lastPing = millis();
  Serial.println("INFO:READY");
}

void loop() {
  // 1. commands from the browser, one line at a time
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n') {
      handleCommand(cmdBuffer);
      cmdBuffer = "";
    } else if (ch != '\r' && cmdBuffer.length() < 20) {
      cmdBuffer += ch;
    }
  }

  unsigned long now = millis();
  bool browserQuiet = now - lastPing > PING_TIMEOUT_MS;

  // 2. safety checks for running pumps
  for (int i = 0; i < 2; i++) {
    if (!pumpOn[i]) continue;
    if (offlineRun[i]) {
      if (now - pumpStarted[i] > OFFLINE_RUN_MS) {
        setPump(i, false);
        Serial.println("INFO:OFFLINE_WATERING_DONE");
      }
    } else if (browserQuiet) {
      setPump(i, false);
      Serial.println("WARN:NO_PING_PUMP_OFF");
    } else if (now - pumpStarted[i] > MAX_RUN_MS) {
      setPump(i, false);
      Serial.println("WARN:MAX_RUN_PUMP_OFF");
    }
  }

  // 3. offline care - nobody is connected and a bed is very dry
  if (now - lastPing > OFFLINE_AFTER_MS) {
    for (int i = 0; i < 2; i++) {
      bool rested = !offlineWatered[i] || now - lastOfflineWater[i] > OFFLINE_GAP_MS;
      if (!pumpOn[i] && lastMoist[i] > 1 && lastMoist[i] < OFFLINE_DRY_PCT && rested) {
        offlineWatered[i] = true;
        lastOfflineWater[i] = now;
        setPump(i, true);
        offlineRun[i] = true;
        Serial.println("INFO:OFFLINE_CARE_WATERING");
      }
    }
  }

  // 4. one reading per second
  if (now - lastData >= 1000) {
    lastData = now;
    int ldr, moist[2];
    float temp;
    readSensors(ldr, moist, temp);
    lastMoist[0] = moist[0];
    lastMoist[1] = moist[1];

    Serial.print("DATA,");
    Serial.print(ldr);      Serial.print(',');
    Serial.print(moist[0]); Serial.print(',');
    Serial.print(moist[1]); Serial.print(',');
    Serial.print(temp, 1);  Serial.print(',');
    Serial.println(USE_REAL_SENSORS ? "REAL" : "SIM");
  }
}
