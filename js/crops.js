// crops.js - crop profiles and the reference samples for the KNN crop guesser
//
// moist    : ideal soil moisture band in % as our sensor reports it after calibration
//            (0 = sensor in dry air, 100 = sensor in water). This is NOT exact volumetric
//            water content, so treat the numbers as a starting point and tune them after
//            watching your own field for a few days.
// critical : below this the plant starts wilting -> always water, even outside the schedule
// temp     : comfortable air temperature range in deg C
// dryRate  : average % moisture lost per hour with no watering (day + night, normal weather)

const CROPS = {
  tomato: {
    name: 'Tomato', moist: [45, 70], critical: 28, temp: [18, 30], dryRate: 1.6,
    tip: 'Water at the base, not on the leaves. Uneven watering leads to cracked fruit and blossom-end rot.'
  },
  chilli: {
    name: 'Chilli', moist: [38, 62], critical: 24, temp: [20, 32], dryRate: 1.3,
    tip: 'Chilli hates standing water. Let the top soil dry slightly between waterings.'
  },
  paddy: {
    name: 'Paddy (rice)', moist: [70, 95], critical: 55, temp: [20, 35], dryRate: 2.2,
    tip: 'Keep the soil saturated at tillering and flowering. Alternate wetting and drying (AWD) after that saves water.'
  },
  wheat: {
    name: 'Wheat', moist: [30, 55], critical: 20, temp: [12, 25], dryRate: 0.9,
    tip: 'Crown root initiation (about 21 days after sowing) and flowering are the stages where missing water hurts yield most.'
  },
  okra: {
    name: 'Okra (bhindi)', moist: [40, 65], critical: 26, temp: [22, 35], dryRate: 1.4,
    tip: 'Keep moisture steady during flowering and fruiting, water stress then causes flower drop.'
  },
  sugarcane: {
    name: 'Sugarcane', moist: [55, 80], critical: 35, temp: [20, 35], dryRate: 1.9,
    tip: 'Water need is highest in the grand growth phase (4-9 months). Trash mulching cuts evaporation.'
  }
};

// [drying rate %/h, average moisture %, pump minutes per day, crop]
// Built from the profiles above assuming the pump raises moisture ~1.8 % per minute,
// with some spread added. Add rows from your own field to improve the guesses.
const CROP_SAMPLES = [
  [1.60, 58, 21, 'tomato'], [1.50, 56, 19, 'tomato'], [1.70, 60, 23, 'tomato'], [1.65, 57, 22, 'tomato'], [1.55, 59, 20, 'tomato'],
  [1.45, 54, 19, 'tomato'], [1.50, 55, 20, 'tomato'],
  [1.30, 48, 17, 'chilli'], [1.20, 46, 15, 'chilli'], [1.35, 50, 18, 'chilli'], [1.25, 45, 16, 'chilli'], [1.30, 47, 16, 'chilli'],
  [2.20, 83, 29, 'paddy'], [2.10, 85, 28, 'paddy'], [2.30, 81, 31, 'paddy'], [2.25, 86, 30, 'paddy'],
  [0.90, 43, 12, 'wheat'], [0.85, 41, 11, 'wheat'], [0.95, 45, 13, 'wheat'], [0.90, 40, 12, 'wheat'],
  [1.35, 51, 18, 'okra'], [1.40, 50, 17, 'okra'], [1.30, 52, 18, 'okra'], [1.38, 49, 17, 'okra'],
  [1.90, 68, 25, 'sugarcane'], [1.95, 70, 26, 'sugarcane'], [1.85, 66, 24, 'sugarcane'], [2.00, 69, 27, 'sugarcane']
];
