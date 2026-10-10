# Smart Irrigation System (Arduino + Machine Learning)

An Arduino based irrigation controller with a web dashboard. The farmer keeps switching the pumps
as usual for a few days; the system learns their watering times for each bed and then takes over,
while checking soil moisture, temperature, light and the pump itself, like a caretaker.

Built with plain **HTML, CSS and JavaScript** (no frameworks) and an **Arduino UNO**.

## Features

- **Login / register.** Passwords are stored as SHA-256 hashes in the browser. Demo account: `demo` / `demo123`.
- **Pump control unit.** Two zones, manual ON/OFF, automatic mode, smart top-up, max run time, emergency stop.
- **Learns the farmer's timings.** Manual waterings are clustered into time slots. A slot seen on 3+ days becomes automatic.
- **Logistic regression model.** Predicts the chance the farmer would water now from moisture, temperature, light, time of day and hours since the last watering. Trained online, every minute.
- **Crop check (KNN, k = 3).** Compares how fast the bed dries, the average moisture and the pump time per day against reference crops (tomato, chilli, paddy, wheat, okra, sugarcane).
- **Plant health (0-100).** Moisture vs the crop's range, heat/cold stress, low light, blocked pipe / empty tank, a faulty sensor, and drying that is unusual for that hour of the day (anomaly detection).
- **Safety.** Dry-run detection, max run time, and auto-pause on sensor fault. The Arduino turns pumps off by itself if the dashboard goes silent, and does "offline care" if the laptop is off.
- **Demo mode.** A simulated farm with a virtual farmer, speed up to 1 s = 1 hour, plus test buttons for rain, heatwave, blocked pipe and unplugged sensor.

## How to run

1. Open `index.html` in **Chrome or Edge** (Web Serial does not work in Firefox/Safari).
   If the browser blocks scripts on `file://`, serve the folder instead:
   ```
   python -m http.server 5500
   ```
   then open http://localhost:5500
2. Log in with `demo` / `demo123` or create an account.
3. Either:
   - **Demo mode:** press *Demo mode*, set speed to *1 s = 1 hour*, and wait about 2 minutes (5 farm days).
     Then open *Learning (ML)* to see the learned times and turn on *Automatic mode* in *Pump control*.
   - **Real hardware:** upload `arduino/smart_irrigation/smart_irrigation.ino`, plug in the USB cable,
     press *Connect Arduino* and choose the port.

## Hardware

| Part | Pin |
|---|---|
| LDR + 10 kΩ divider | A0 |
| Soil moisture sensor, zone 1 | A1 |
| LM35 temperature sensor | A2 |
| Soil moisture sensor, zone 2 | A3 |
| Relay IN1 → pump 1 | D7 |
| Relay IN2 → pump 2 | D8 |

In the sketch, set `USE_REAL_SENSORS = true` once the sensors are wired. Calibrate `MOIST_DRY` / `MOIST_WET`
(raw reading in dry air / in water) for each sensor. Pumps need their own power supply, not the Arduino 5 V pin.

### Serial protocol (9600 baud)

```
Arduino -> PC   DATA,<ldr>,<moist1 %>,<moist2 %>,<temp C>,<REAL|SIM>   every second
                PUMP1:ON | PUMP1:OFF | PUMP2:ON | PUMP2:OFF            on every change
                WARN:NO_PING_PUMP_OFF | WARN:MAX_RUN_PUMP_OFF
                INFO:...
PC -> Arduino   ON1 | OFF1 | ON2 | OFF2 | ALLOFF | PING (every 2 s)
```

## How a decision is made (every minute, per zone)

1. **Safety:** stop if moisture did not rise 2 % in 5 min (dry run), the max run time is reached, or the sensor reads 0.
2. **Wilting point:** moisture below the crop's critical level → water.
3. **Learned time:** at a learned slot, water unless the soil is already above mid-range (rain) → skip and log.
4. **Model:** logistic regression p ≥ 0.6 and soil below mid-range → water.
5. **Top-up:** below the ideal range for 45 min → top-up (only 05-11 h and 16-20 h).

A run stops at the target moisture. Automatic runs at learned times that the farmer lets happen count as
confirmations; if the farmer cancels one within 5 min it is marked as unwanted.

## Project structure

```
index.html            login / register page
dashboard.html        control panel (7 pages)
css/style.css         all styling
js/common.js          small helpers, storage, toast
js/auth.js            accounts + session (SHA-256 hashed passwords)
js/login.js           login page wiring
js/crops.js           crop profiles + KNN reference samples
js/ml.js              ScheduleLearner, NeedModel (logistic regression), Baseline, CropKNN, Health
js/hardware.js        ArduinoLink (Web Serial) + FarmSimulator (demo)
js/app.js             dashboard logic: readings -> learning -> decisions -> pumps, rendering
arduino/smart_irrigation/smart_irrigation.ino   Arduino UNO firmware
```

## Limitations / future work

- The laptop must stay on for learning and automatic mode. An ESP32 with Wi-Fi could host it instead.
- Crop check only uses water behaviour. A leaf image model would give a real disease check.
- A weather forecast API could skip watering before rain.
- Data lives in the browser (localStorage). Use *Setup → Export backup* to keep a copy.
