"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSmartLockNotification = exports.switchSmartLockNotification = exports.getLockEventType = exports.getFloodLightT8425Notification = exports.isFloodlightT8425NotificationEnabled = exports.getIndoorNotification = exports.isIndoorNotificationEnabled = exports.getIndoorS350DetectionMode = exports.isIndoorS350DetectionModeEnabled = exports.getT8110DetectionMode = exports.isT8110DetectionModeEnabled = exports.getT8170DetectionMode = exports.isT8170DetectionModeEnabled = exports.decryptTrackerData = exports.isPrioritySourceType = exports.getImage = exports.getImagePath = exports.decodeImageAsync = exports.decodeImage = exports.getImageKey = exports.getImageSeed = exports.getImageBaseCode = exports.getIdSuffix = exports.randomNumber = exports.hexStringScheduleToSchedule = exports.hexWeek = exports.hexTime = exports.hexDate = exports.encodePasscode = exports.ParsePayload = exports.WritePayload = exports.getAdvancedLockTimezone = exports.getEufyTimezone = exports.getHB3DetectionMode = exports.isHB3DetectionModeEnabled = exports.isDeliveryPackageType = exports.getDistances = exports.getBlocklist = exports.decryptAPIData = exports.encryptAPIData = exports.calculateCellularSignalLevel = exports.calculateWifiSignalLevel = exports.switchNotificationMode = exports.isNotificationSwitchMode = exports.getImageFilePath = exports.getAbsoluteFilePath = exports.getTimezoneGMTString = exports.pad = exports.isGreaterEqualMinVersion = exports.normalizeVersionString = void 0;
exports.getRandomPhoneModel = exports.loadEventImage = exports.loadImageOverP2P = exports.getWaitSeconds = void 0;
const crypto_1 = require("crypto");
const const_1 = require("./const");
const md5_1 = __importDefault(require("crypto-js/md5"));
const enc_hex_1 = __importDefault(require("crypto-js/enc-hex"));
const sha256_1 = __importDefault(require("crypto-js/sha256"));
const types_1 = require("./types");
const decodeImageV2_1 = require("./decodeImageV2");
const error_1 = require("../error");
const error_2 = require("./error");
const types_2 = require("./../push/types");
const logging_1 = require("../logging");
const utils_1 = require("../utils");
const normalizeVersionString = function (version) {
    /**
     *
     * Normalise version strings into an array of integers, otherwise if a version was not found it returns null
     * Example of a version is 1.4.30.33
     *
     * @param version
     */
    const match = version.match(/\d+(?:\.\d+)+/);
    if (match == null)
        return null;
    else {
        return match[0].split(".").map(Number);
    }
};
exports.normalizeVersionString = normalizeVersionString;
const isGreaterEqualMinVersion = function (minimal_version, current_version) {
    /**
     *
     *  Test the minimal version set is working with the current version by return true if it is equal or greater than min version.
     *
     * @param minimal_version
     * @param current_version
     */
    const min_version = (0, exports.normalizeVersionString)(minimal_version);
    const actual_version = (0, exports.normalizeVersionString)(current_version);
    // Failed to parse actually version
    if (actual_version === null)
        return false;
    // Failed to a parse min version but the current did, so we assume it is greater
    if (min_version === null)
        return true;
    const version_slots = Math.min(min_version.length, actual_version.length);
    let i;
    // Loop for each slot to ensure it is greater or equal
    for (i = 0; i < version_slots; i += 1) {
        if (min_version[i] !== actual_version[i]) {
            return min_version[i] < actual_version[i];
        }
    }
    // If none of the slots are different but the length is the same, it is most likely the slots are the same
    if (min_version.length === actual_version.length) {
        return true;
    }
    return min_version.length < actual_version.length;
};
exports.isGreaterEqualMinVersion = isGreaterEqualMinVersion;
const pad = function (num) {
    /**
     *
     *  Convert the number to be absolute, round down and return "0" if lower than 10 or "" otherwise
     *  Seems to be used in a scenario where need to add a zero decimal to format a 2 digit string
     *
     * @param num
     */
    const norm = Math.floor(Math.abs(num));
    return (norm < 10 ? "0" : "") + norm;
};
exports.pad = pad;
const getTimezoneGMTString = function () {
    /**
     * Get timezone to string
     *
     */
    const tzo = -new Date().getTimezoneOffset();
    const dif = tzo >= 0 ? "+" : "-";
    return `GMT${dif}${(0, exports.pad)(tzo / 60)}:${(0, exports.pad)(tzo % 60)}`;
};
exports.getTimezoneGMTString = getTimezoneGMTString;
const getAbsoluteFilePath = function (device_type, channel, filename) {
    /**
     *
     *   Create the path based on two different devices
     *
     * @param device_type
     * @param channel
     * @param filename
     */
    // TODO : might need to extend to others device with local storage? not sure why only floodlight
    const prefix = device_type === types_1.DeviceType.FLOODLIGHT ? const_1.PATH_DATA_CAMERA : const_1.PATH_MMC_CAMERA;
    return `${prefix}${String(channel).padStart(2, "0")}/${filename}.dat`;
};
exports.getAbsoluteFilePath = getAbsoluteFilePath;
const getImageFilePath = function (device_type, channel, filename) {
    /**
     *
     *  Create the image path from a video filename
     *
     * @param device_type
     * @param channel
     * @param filename
     */
    // TODO : might need to extend to others device with local storage? not sure why only floodlight
    const prefix = device_type === types_1.DeviceType.FLOODLIGHT ? const_1.PATH_DATA_VIDEO : const_1.PATH_MMC_VIDEO;
    return `${prefix}/${filename}_c${String(channel).padStart(2, "0")}.jpg`;
};
exports.getImageFilePath = getImageFilePath;
const isNotificationSwitchMode = function (value, mode) {
    /**
     *
     *   Check if the mode is set to notification
     *
     * @param value
     * @param mode
     */
    if (value === 1)
        value = 240;
    return (value & mode) !== 0;
};
exports.isNotificationSwitchMode = isNotificationSwitchMode;
const switchNotificationMode = function (currentValue, mode, enable) {
    let result = 0;
    if (!enable && currentValue === 1 /* ALL */) {
        currentValue = 240;
    }
    if (enable) {
        result = mode | currentValue;
    }
    else {
        result = ~mode & currentValue;
    }
    if ((0, exports.isNotificationSwitchMode)(result, types_1.NotificationSwitchMode.SCHEDULE) &&
        (0, exports.isNotificationSwitchMode)(result, types_1.NotificationSwitchMode.APP) &&
        (0, exports.isNotificationSwitchMode)(result, types_1.NotificationSwitchMode.GEOFENCE) &&
        (0, exports.isNotificationSwitchMode)(result, types_1.NotificationSwitchMode.KEYPAD)) {
        result = 1; /* ALL */
    }
    return result;
};
exports.switchNotificationMode = switchNotificationMode;
// TODO : remove device , not needed
const calculateWifiSignalLevel = function (device, rssi) {
    /**
     *  Calculate the signal strength based on the RSSI
     *
     *  Using this scale for reference
     *  Excellent/Very Strong (-30 dBm to -50 dBm)
     *  Good/Strong (-50 dBm to -60 dBm)
     *  Fair/Good (-60 dBm to -67 dBm)
     *  Weak/Fair (-67 dBm to -70 dBm)
     *  Very Weak/Poor (-70 dBm to -80 dBm)
     *  Unusable (-80 dBm to -90 dBm or lower)
     *
     */
    if (rssi >= -50)
        return types_1.SignalLevel.FULL;
    else if (rssi < -50 && rssi >= -60)
        return types_1.SignalLevel.STRONG;
    else if (rssi < -60 && rssi >= -67)
        return types_1.SignalLevel.NORMAL;
    else if (rssi < -67 && rssi >= -80)
        return types_1.SignalLevel.WEAK;
    else
        return types_1.SignalLevel.NO_SIGNAL;
};
exports.calculateWifiSignalLevel = calculateWifiSignalLevel;
const calculateCellularSignalLevel = function (rssi) {
    /**
     *  Calculate the signal strength from the RSSI ( this has a different scale than wifi )
     *
     * Excellent (>-65 to -70 dBm)
     * Good (-70 to -85 dBm)
     * Fair (-85 to -95 dBm)
     * Poor (-95 to -100 dBm)
     * Unusable/No Signal (<-100 to -110 dBm)
     *
     */
    if (rssi >= 0)
        return types_1.SignalLevel.NO_SIGNAL;
    if (rssi >= -70)
        return types_1.SignalLevel.FULL;
    else if (rssi < -70 && rssi >= -85)
        return types_1.SignalLevel.STRONG;
    else if (rssi < -85 && rssi >= -95)
        return types_1.SignalLevel.NORMAL;
    else if (rssi < -95 && rssi >= -100)
        return types_1.SignalLevel.WEAK;
    else
        return types_1.SignalLevel.NO_SIGNAL;
};
exports.calculateCellularSignalLevel = calculateCellularSignalLevel;
const encryptAPIData = (data, key) => {
    const cipher = (0, crypto_1.createCipheriv)("aes-256-cbc", key, key.subarray(0, 16));
    return cipher.update(data, "utf8", "base64") + cipher.final("base64");
};
exports.encryptAPIData = encryptAPIData;
const decryptAPIData = (data, key) => {
    const cipher = (0, crypto_1.createDecipheriv)("aes-256-cbc", key, key.subarray(0, 16));
    return Buffer.concat([cipher.update(data, "base64"), cipher.final()]);
};
exports.decryptAPIData = decryptAPIData;
const getBlocklist = function (distanceArray) {
    /**
     *  It looks like it taken from the decompiled app from Eufy in the file SimpleDetectionGroup.java
     *
     *  From asking, AI, this function it creates a bitmask representing which radar points meet that distance requirement.
     *  Finally, it applies a specific bitwise transformation to that mask.
     *
     *  Potential description: Generates radar configuration parameters based on distance thresholds.
     *
     *  * @param {number[]} distanceArray - An array of integers representing distances.
     *  * @returns {number[]} A list of 5 bitmask integers.
     */
    const requestParams = [];
    for (let threshold = 1; threshold <= 5; threshold++) {
        let bitmask = 0;
        let bitPosition = 1;
        // Iterate through each distance in the array
        for (const distance of distanceArray) {
            if (distance >= threshold) {
                bitmask |= bitPosition;
            }
            // Shift bitPosition left by 1 (multiply by 2)
            bitPosition <<= 1;
        }
        let finalValue = 0;
        // Logic for specific bit patterns
        if (bitmask === 0) {
            finalValue = 0xffff; // 65535
        }
        else if (bitmask !== 0xff && bitmask !== 0xffff) {
            // Flip the bits and add the 0xFF00 (65280) high-byte padding
            finalValue = (bitmask ^ 0xff) + 0xff00;
        }
        requestParams.push(finalValue);
    }
    return requestParams;
};
exports.getBlocklist = getBlocklist;
const getDistances = function (rawDistanceData) {
    /**
     *  It looks like it taken from the decompiled app from Eufy in the file SimpleDetectionGroup.java
     *
     *  From asking AI:
     *  Processes raw radar sensor data to map object detections into spatial sectors.
     *  This method iterates through a list of distance data, where each element represents
     *  a depth level and its bits represent angular sectors. It inverts the bitmask,
     *  identifies active detections via bit-shifting, and updates a collection of
     *  RadarSelectInfo objects with the corresponding angle and proximity distance.
     *
     *   @param rawDistanceData A list of integers where each bit represents a detection
     *   at a specific angle, and the list index represents depth.
     */
    const radarSectors = [3, 3, 3, 3, 3, 3, 3, 3];
    let distanceStep = 0;
    for (const rawValue of rawDistanceData) {
        // Bitwise NOT/XOR to invert the signal (common in hardware where 0=detected)
        let invertedBits = rawValue ^ 65535;
        distanceStep++;
        if (invertedBits !== 0) {
            for (let i = 0; i < radarSectors.length; i++) {
                const isObjectDetected = invertedBits & 1; // Check if the lowest bit is set
                // If the bit was 1, mark this sector with the current distance
                if (isObjectDetected > 0) {
                    radarSectors[i] = distanceStep;
                }
                // Shift bits to check the next angle in the next iteration
                invertedBits = invertedBits >> 1;
            }
        }
    }
    return radarSectors;
};
exports.getDistances = getDistances;
const isDeliveryPackageType = function (value) {
    /**
     *  Seems to be coming from EventData.java
     *
     */
    return (value & 65536) == 65536;
};
exports.isDeliveryPackageType = isDeliveryPackageType;
const isHB3DetectionModeEnabled = function (value, type) {
    /**
     * Detection if Mode is enabled
     *
     */
    const prefixCode = (type & value) == type;
    if (type === types_1.HB3DetectionTypes.HUMAN_RECOGNITION) {
        return prefixCode && (0, exports.isDeliveryPackageType)(value);
    }
    else if (type === types_1.HB3DetectionTypes.HUMAN_DETECTION) {
        return prefixCode && (value & 1) == 1;
    }
    return prefixCode;
};
exports.isHB3DetectionModeEnabled = isHB3DetectionModeEnabled;
const getHB3DetectionMode = function (value, type, enable) {
    let result = 0;
    if (!enable) {
        if (type === types_1.HB3DetectionTypes.HUMAN_RECOGNITION) {
            const tmp = (type & value) == type ? type ^ value : value;
            result = (0, exports.isDeliveryPackageType)(value) ? tmp ^ 65536 : tmp;
        }
        else if (type === types_1.HB3DetectionTypes.HUMAN_DETECTION) {
            const tmp = (type & value) == type ? type ^ value : value;
            result = (value & 1) == 1 ? tmp ^ 1 : tmp;
        }
        else {
            result = type ^ value;
        }
    }
    else {
        if (type === types_1.HB3DetectionTypes.HUMAN_RECOGNITION) {
            result = type | value | 65536;
        }
        else if (type === types_1.HB3DetectionTypes.HUMAN_DETECTION) {
            result = type | value | 1;
        }
        else {
            result = type | value;
        }
    }
    return result;
};
exports.getHB3DetectionMode = getHB3DetectionMode;
const getEufyTimezone = function () {
    for (const timezone of const_1.timeZoneData) {
        if (timezone.timeId === Intl.DateTimeFormat().resolvedOptions().timeZone) {
            return timezone;
        }
    }
    return undefined;
};
exports.getEufyTimezone = getEufyTimezone;
const getAdvancedLockTimezone = function (stationSN) {
    const timezone = (0, exports.getEufyTimezone)();
    if (timezone !== undefined) {
        // TODO: make this a method to check whatever we need to check for the station
        if (stationSN.startsWith("T8520") && (0, exports.isGreaterEqualMinVersion)("1.2.8.6", stationSN))
            return `${timezone.timeZoneGMT}|1.${timezone.timeSn}`;
        else
            return timezone.timeZoneGMT;
    }
    return "";
};
exports.getAdvancedLockTimezone = getAdvancedLockTimezone;
class WritePayload {
    split_byte = -95;
    data = Buffer.from([]);
    write(bytes) {
        const tmp_data = Buffer.from(bytes);
        this.data = Buffer.concat([
            this.data,
            Buffer.from([this.split_byte]),
            Buffer.from([tmp_data.length & 255]),
            tmp_data,
        ]);
        this.split_byte += 1;
    }
    getData() {
        return this.data;
    }
}
exports.WritePayload = WritePayload;
class ParsePayload {
    /**
     * extract specific pieces of data from a binary buffer
     *
     * @private
     */
    data;
    constructor(data) {
        this.data = data;
    }
    readUint32BE(indexValue) {
        return this.readData(indexValue).readUint32BE();
    }
    readUint32LE(indexValue) {
        return this.readData(indexValue).readUint32LE();
    }
    readUint16BE(indexValue) {
        return this.readData(indexValue).readUint16BE();
    }
    readUint16LE(indexValue) {
        return this.readData(indexValue).readUint16LE();
    }
    readString(indexValue) {
        return this.readData(indexValue).toString();
    }
    readStringHex(indexValue) {
        return this.readData(indexValue).toString("hex");
    }
    readInt8(indexValue) {
        let dataPosition = this.getDataPosition(indexValue);
        if (dataPosition == -1) {
            return 0;
        }
        dataPosition = dataPosition + 2;
        if (dataPosition >= this.data.length) {
            return 0;
        }
        return this.data.readInt8(dataPosition);
    }
    readData(indexValue) {
        let dataPosition = this.getDataPosition(indexValue);
        if (dataPosition == -1) {
            return Buffer.from("");
        }
        dataPosition++;
        if (dataPosition >= this.data.length) {
            return Buffer.from("");
        }
        const nextStep = this.getNextStep(indexValue, dataPosition, this.data);
        let tmp;
        if (nextStep == 1) {
            tmp = this.data.readInt8(dataPosition);
        }
        else {
            tmp = this.data.readUint16LE(dataPosition);
        }
        if (dataPosition + nextStep + tmp > this.data.length) {
            return Buffer.from("");
        }
        return this.data.subarray(dataPosition + nextStep, dataPosition + nextStep + tmp);
    }
    getDataPosition(indexValue) {
        if (this.data && this.data.length >= 1) {
            for (let currentPosition = 0; currentPosition < this.data.length;) {
                if (this.data.readInt8(currentPosition) == indexValue) {
                    return currentPosition;
                }
                else {
                    const value = this.data.readInt8(currentPosition);
                    currentPosition++;
                    if (currentPosition >= this.data.length) {
                        break;
                    }
                    const nextStep = this.getNextStep(value, currentPosition, this.data);
                    if (currentPosition + nextStep >= this.data.length) {
                        break;
                    }
                    if (nextStep == 1) {
                        currentPosition = this.data.readInt8(currentPosition) + currentPosition + nextStep;
                    }
                    else {
                        currentPosition = this.data.readUint16LE(currentPosition) + currentPosition + nextStep;
                    }
                }
            }
        }
        return -1;
    }
    getNextStep(indexValue, position, data) {
        const newPosition = position + 1 + data.readUInt8(position);
        return newPosition == data.length || newPosition > data.length || data.readInt8(newPosition) == indexValue + 1
            ? 1
            : 2;
    }
}
exports.ParsePayload = ParsePayload;
const encodePasscode = function (pass) {
    /**
     *  Encode the passcode for smart lock
     *
     */
    let result = "";
    for (let i = 0; i < pass.length; i++)
        result += pass.charCodeAt(i).toString(16);
    return result;
};
exports.encodePasscode = encodePasscode;
const hexDate = function (date) {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUint8(date.getDate());
    buf.writeUint8(date.getMonth() + 1, 1);
    buf.writeUint16BE(date.getFullYear(), 2);
    return buf.readUInt32LE().toString(16).padStart(8, "0");
};
exports.hexDate = hexDate;
const hexTime = function (date) {
    const buf = Buffer.allocUnsafe(2);
    buf.writeUint8(date.getHours());
    buf.writeUint8(date.getMinutes(), 1);
    return buf.readUInt16BE().toString(16).padStart(4, "0");
};
exports.hexTime = hexTime;
const hexWeek = function (schedule) {
    const SUNDAY = 1;
    const MONDAY = 2;
    const TUESDAY = 4;
    const WEDNESDAY = 8;
    const THURSDAY = 16;
    const FRIDAY = 32;
    const SATURDAY = 64;
    let result = 0;
    if (schedule.week !== undefined) {
        if (schedule.week.sunday) {
            result |= SUNDAY;
        }
        if (schedule.week.monday) {
            result |= MONDAY;
        }
        if (schedule.week.tuesday) {
            result |= TUESDAY;
        }
        if (schedule.week.wednesday) {
            result |= WEDNESDAY;
        }
        if (schedule.week.thursday) {
            result |= THURSDAY;
        }
        if (schedule.week.friday) {
            result |= FRIDAY;
        }
        if (schedule.week.saturday) {
            result |= SATURDAY;
        }
        return result.toString(16);
    }
    return "ff";
};
exports.hexWeek = hexWeek;
const hexStringScheduleToSchedule = function (startDay, startTime, endDay, endTime, week) {
    const SUNDAY = 1;
    const MONDAY = 2;
    const TUESDAY = 4;
    const WEDNESDAY = 8;
    const THURSDAY = 16;
    const FRIDAY = 32;
    const SATURDAY = 64;
    const weekNumber = Number.parseInt(week, 16);
    return {
        startDateTime: startDay === "00000000"
            ? undefined
            : new Date(Number.parseInt(`${startDay.substring(2, 4)}${startDay.substring(0, 2)}`, 16), Number.parseInt(startDay.substring(4, 6), 16) - 1, Number.parseInt(startDay.substring(6, 8), 16), Number.parseInt(startTime.substring(0, 2), 16), Number.parseInt(startTime.substring(2, 4), 16)),
        endDateTime: endDay === "ffffffff"
            ? undefined
            : new Date(Number.parseInt(`${endDay.substring(2, 4)}${endDay.substring(0, 2)}`, 16), Number.parseInt(endDay.substring(4, 6), 16) - 1, Number.parseInt(endDay.substring(6, 8), 16), Number.parseInt(endTime.substring(0, 2), 16), Number.parseInt(endTime.substring(2, 4), 16)),
        week: {
            monday: (weekNumber & MONDAY) == MONDAY,
            tuesday: (weekNumber & TUESDAY) == TUESDAY,
            wednesday: (weekNumber & WEDNESDAY) == WEDNESDAY,
            thursday: (weekNumber & THURSDAY) == THURSDAY,
            friday: (weekNumber & FRIDAY) == FRIDAY,
            saturday: (weekNumber & SATURDAY) == SATURDAY,
            sunday: (weekNumber & SUNDAY) == SUNDAY,
        },
    };
};
exports.hexStringScheduleToSchedule = hexStringScheduleToSchedule;
const randomNumber = function (min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};
exports.randomNumber = randomNumber;
const getIdSuffix = function (p2pDid) {
    let result = 0;
    const match = p2pDid.match(/^[A-Z]+-(\d+)-[A-Z]+$/);
    if (match?.length == 2) {
        const num1 = Number.parseInt(match[1][0]);
        const num2 = Number.parseInt(match[1][1]);
        const num3 = Number.parseInt(match[1][3]);
        const num4 = Number.parseInt(match[1][5]);
        result = num1 + num2 + num3;
        if (num3 < 5) {
            result = result + num3;
        }
        result = result + num4;
    }
    return result;
};
exports.getIdSuffix = getIdSuffix;
const getImageBaseCode = function (serialNumber, p2pDid) {
    let nr = 0;
    try {
        nr = Number.parseInt(`0x${serialNumber[serialNumber.length - 1]}`);
    }
    catch (err) {
        const error = (0, error_1.ensureError)(err);
        throw new error_2.ImageBaseCodeError("Error generating image base code", {
            cause: error,
            context: { serialnumber: serialNumber, p2pDid: p2pDid },
        });
    }
    nr = (nr + 10) % 10;
    const base = serialNumber.substring(nr);
    return `${base}${(0, exports.getIdSuffix)(p2pDid)}`;
};
exports.getImageBaseCode = getImageBaseCode;
const getImageSeed = function (p2pDid, code) {
    try {
        const nCode = Number.parseInt(code.substring(2));
        const prefix = 1000 - (0, exports.getIdSuffix)(p2pDid);
        return (0, md5_1.default)(`${prefix}${nCode}`).toString(enc_hex_1.default).toUpperCase();
    }
    catch (err) {
        const error = (0, error_1.ensureError)(err);
        throw new error_2.ImageBaseCodeError("Error generating image seed", {
            cause: error,
            context: { p2pDid: p2pDid, code: code },
        });
    }
};
exports.getImageSeed = getImageSeed;
const getImageKey = function (serialNumber, p2pDid, code) {
    const baseCode = (0, exports.getImageBaseCode)(serialNumber, p2pDid);
    const seed = (0, exports.getImageSeed)(p2pDid, code);
    const data = `01${baseCode}${seed}`;
    const hash = (0, sha256_1.default)(data);
    const hashBytes = [...Buffer.from(hash.toString(enc_hex_1.default), "hex")];
    const startByte = hashBytes[10];
    for (let i = 0; i < 32; i++) {
        const byte = hashBytes[i];
        let fixed_byte = startByte;
        if (i < 31) {
            fixed_byte = hashBytes[i + 1];
        }
        if (i == 31 || (i & 1) != 0) {
            hashBytes[10] = fixed_byte;
            if (126 < byte || 126 < hashBytes[10]) {
                if (byte < hashBytes[10] || byte - hashBytes[10] == 0) {
                    hashBytes[i] = hashBytes[10] - byte;
                }
                else {
                    hashBytes[i] = byte - hashBytes[10];
                }
            }
        }
        else if (byte < 125 || fixed_byte < 125) {
            hashBytes[i] = fixed_byte + byte;
        }
    }
    return `${Buffer.from(hashBytes.slice(16)).toString("hex").toUpperCase()}`;
};
exports.getImageKey = getImageKey;
const decodeImage = function (p2pDid, data) {
    if (data.length >= 12) {
        // v6 "v2_eufysecurity:" thumbnails: head-only obfuscation, decodable WITHOUT
        // any key (see decodeImageV2.ts). The encrypted JPEG header only hid the
        // quantization tables + dimensions; the scan data is plaintext standard JPEG.
        //
        // NOTE / LIMITATION: this synchronous path reconstructs with a FIXED geometry of
        // 288x176 4:2:0 — the standard push-notification thumbnail size (validated against
        // the app's own decoded heap JPEG, 2026-06-10). Images of OTHER sizes (e.g. the
        // 256x144 / 640x360 frames also seen in RAM, or 4:4:4 snapshots) are SHEARED here,
        // because their true dimensions can only be recovered by trial decoding (async).
        //
        // Prefer the async {@link decodeImageAsync} (used by api.ts getImage, the path
        // that actually receives v2 blobs) — it auto-detects width/height/subsampling via
        // decodeV2ImageAuto() and handles every size. This sync splice is the fallback for
        // sync callers (p2p/session.ts, which only ever receives plain JPEGs) and for when
        // the optional jpeg-js dep is absent.
        if (data.subarray(0, decodeImageV2_1.V2_PREFIX.length).toString("latin1") === decodeImageV2_1.V2_PREFIX) {
            const spliced = (0, decodeImageV2_1.spliceV2Image)(data, 288, 176, "4:2:0");
            return spliced ?? data;
        }
        const header = data.subarray(0, 12).toString();
        if (header === "eufysecurity") {
            const serialNumber = data.subarray(13, 29).toString();
            const code = data.subarray(30, 40).toString();
            const imageKey = (0, exports.getImageKey)(serialNumber, p2pDid, code);
            const otherData = data.subarray(41);
            const encryptedData = otherData.subarray(0, 256);
            const cipher = (0, crypto_1.createDecipheriv)("aes-128-ecb", Buffer.from(imageKey, "utf-8").subarray(0, 16), null);
            cipher.setAutoPadding(false);
            const decryptedData = Buffer.concat([cipher.update(encryptedData), cipher.final()]);
            decryptedData.copy(otherData);
            return otherData;
        }
    }
    return data;
};
exports.decodeImage = decodeImage;
/**
 * Async variant of {@link decodeImage}. For v6 `v2_eufysecurity:` thumbnails it
 * recovers the EXACT geometry (width / height / chroma subsampling) by trial
 * decoding ({@link decodeV2ImageAuto}, via the optional jpeg-js dependency)
 * instead of assuming a fixed size, so thumbnails of any resolution decode
 * without shearing. Falls back to the synchronous fixed-geometry splice when
 * auto-detection is unavailable (jpeg-js absent) or fails. All non-v2 inputs are
 * delegated unchanged to the synchronous {@link decodeImage}.
 */
const decodeImageAsync = async function (p2pDid, data) {
    if (data.length >= decodeImageV2_1.V2_PREFIX.length && data.subarray(0, decodeImageV2_1.V2_PREFIX.length).toString("latin1") === decodeImageV2_1.V2_PREFIX) {
        try {
            const auto = await (0, decodeImageV2_1.decodeV2ImageAuto)(data);
            if (auto)
                return auto.jpeg;
        }
        catch {
            // fall through to the synchronous fixed-geometry splice below
        }
    }
    return (0, exports.decodeImage)(p2pDid, data);
};
exports.decodeImageAsync = decodeImageAsync;
const getImagePath = function (path) {
    const splitPath = path.split("~");
    if (splitPath.length === 2) {
        return splitPath[1];
    }
    return path;
};
exports.getImagePath = getImagePath;
// TODO: make up some testing
const getImage = async function (api, serial, url) {
    const { default: imageType } = await import("image-type");
    const image = await api.getImage(serial, url);
    const type = await imageType(image);
    return {
        data: image,
        type: type !== null && type !== undefined ? type : { ext: "unknown", mime: "application/octet-stream" },
    };
};
exports.getImage = getImage;
const isPrioritySourceType = function (current, update) {
    return (((current === "http" || current === "p2p" || current === "push" || current === "mqtt" || current === undefined) &&
        (update === "p2p" || update === "push" || update === "mqtt")) ||
        ((current === "http" || current === undefined) && update === "http"));
};
exports.isPrioritySourceType = isPrioritySourceType;
const decryptTrackerData = (data, key) => {
    const decipher = (0, crypto_1.createDecipheriv)("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
};
exports.decryptTrackerData = decryptTrackerData;
// TODO: this seems to be used before above
const isT8170DetectionModeEnabled = function (value, type) {
    return (type & value) == type;
};
exports.isT8170DetectionModeEnabled = isT8170DetectionModeEnabled;
// TODO this seems like  getHB3DetectionMode
const getT8170DetectionMode = function (value, type, enable) {
    let result = 0;
    if (Object.values(types_1.T8170DetectionTypes).includes(type) &&
        Object.values(types_1.T8170DetectionTypes).includes(value) &&
        !enable)
        return value;
    if (!enable) {
        result = type ^ value;
    }
    else {
        result = type | value;
    }
    return result;
};
exports.getT8170DetectionMode = getT8170DetectionMode;
// TODO: Tidy up!!
const isT8110DetectionModeEnabled = function (value, type) {
    return (type & value) == type;
};
exports.isT8110DetectionModeEnabled = isT8110DetectionModeEnabled;
const getT8110DetectionMode = function (value, type, enable) {
    let result = 0;
    if (Object.values(types_1.EufyCamC35DetectionTypes).includes(type) &&
        Object.values(types_1.EufyCamC35DetectionTypes).includes(value) &&
        !enable)
        return value;
    if (!enable) {
        result = type ^ value;
    }
    else {
        result = type | value;
    }
    return result;
};
exports.getT8110DetectionMode = getT8110DetectionMode;
// TODO: this is like isT8170DetectionModeEnabled
const isIndoorS350DetectionModeEnabled = function (value, type) {
    return (type & value) == type;
};
exports.isIndoorS350DetectionModeEnabled = isIndoorS350DetectionModeEnabled;
// TODO: this is like getT8170DetectionMode
const getIndoorS350DetectionMode = function (value, type, enable) {
    let result = 0;
    if (Object.values(types_1.IndoorS350DetectionTypes).includes(type) &&
        Object.values(types_1.IndoorS350DetectionTypes).includes(value) &&
        !enable)
        return value;
    if (!enable) {
        result = type ^ value;
    }
    else {
        result = type | value;
    }
    return result;
};
exports.getIndoorS350DetectionMode = getIndoorS350DetectionMode;
// TODO: this is like isT8170DetectionModeEnabled
const isIndoorNotificationEnabled = function (value, type) {
    return (type & value) == type;
};
exports.isIndoorNotificationEnabled = isIndoorNotificationEnabled;
// TODO: this is like getT8170DetectionMode
const getIndoorNotification = function (value, type, enable) {
    let result = 0;
    if (!enable) {
        result = (type ^ value) + 800;
    }
    else {
        result = type | value;
    }
    return result;
};
exports.getIndoorNotification = getIndoorNotification;
// TODO: this is like isT8170DetectionModeEnabled
const isFloodlightT8425NotificationEnabled = function (value, type) {
    return (type & value) == type;
};
exports.isFloodlightT8425NotificationEnabled = isFloodlightT8425NotificationEnabled;
// TODO: this is like getT8170DetectionMode
const getFloodLightT8425Notification = function (value, type, enable) {
    let result = 0;
    if (!enable) {
        result = type ^ value;
    }
    else {
        result = type | value;
    }
    return result;
};
exports.getFloodLightT8425Notification = getFloodLightT8425Notification;
const getLockEventType = function (event) {
    switch (event) {
        case types_2.LockPushEvent.AUTO_LOCK:
        case types_2.LockPushEvent.AUTO_UNLOCK:
            return 1;
        case types_2.LockPushEvent.MANUAL_LOCK:
        case types_2.LockPushEvent.MANUAL_UNLOCK:
            return 2;
        case types_2.LockPushEvent.APP_LOCK:
        case types_2.LockPushEvent.APP_UNLOCK:
            return 3;
        case types_2.LockPushEvent.PW_LOCK:
        case types_2.LockPushEvent.PW_UNLOCK:
            return 4;
        case types_2.LockPushEvent.FINGER_LOCK:
        case types_2.LockPushEvent.FINGERPRINT_UNLOCK:
            return 5;
        case types_2.LockPushEvent.TEMPORARY_PW_LOCK:
        case types_2.LockPushEvent.TEMPORARY_PW_UNLOCK:
            return 6;
        case types_2.LockPushEvent.KEYPAD_LOCK:
            return 7;
    }
    return 0;
};
exports.getLockEventType = getLockEventType;
// TODO: this is like getT8170DetectionMode
const switchSmartLockNotification = function (currentValue, mode, enable) {
    let result = 0;
    if (enable) {
        result = mode | currentValue;
    }
    else {
        result = ~mode & currentValue;
    }
    return result;
};
exports.switchSmartLockNotification = switchSmartLockNotification;
// TODO: this is like isT8170DetectionModeEnabled
const isSmartLockNotification = function (value, mode) {
    return (value & mode) !== 0;
};
exports.isSmartLockNotification = isSmartLockNotification;
const getWaitSeconds = (device) => {
    let seconds = 60;
    const workingMode = device.getPropertyValue(types_1.PropertyName.DevicePowerWorkingMode);
    if (workingMode !== undefined && workingMode === 2) {
        const customValue = device.getPropertyValue(types_1.PropertyName.DeviceRecordingClipLength);
        if (customValue !== undefined) {
            seconds = customValue;
        }
    }
    return seconds;
};
exports.getWaitSeconds = getWaitSeconds;
const loadImageOverP2P = function (station, device, id, p2pTimeouts) {
    if (station.hasCommand(types_1.CommandName.StationDatabaseQueryLatestInfo) && p2pTimeouts.get(id) === undefined) {
        const seconds = (0, exports.getWaitSeconds)(device);
        p2pTimeouts.set(id, setTimeout(async () => {
            station.databaseQueryLatestInfo();
            p2pTimeouts.delete(id);
        }, seconds * 1000));
    }
};
exports.loadImageOverP2P = loadImageOverP2P;
const loadEventImage = function (station, api, device, message, p2pTimeouts) {
    if (message.notification_style === types_1.NotificationType.MOST_EFFICIENT) {
        (0, exports.loadImageOverP2P)(station, device, device.getSerial(), p2pTimeouts);
    }
    else {
        if (!(0, utils_1.isEmpty)(message.pic_url)) {
            (0, exports.getImage)(api, device.getSerial(), message.pic_url)
                .then((image) => {
                if (image.data.length > 0) {
                    if (p2pTimeouts.get(device.getSerial()) !== undefined) {
                        clearTimeout(p2pTimeouts.get(device.getSerial()));
                        p2pTimeouts.delete(device.getSerial());
                    }
                    device.updateProperty(types_1.PropertyName.DevicePicture, image, true);
                }
                else {
                    //fallback
                    (0, exports.loadImageOverP2P)(station, device, device.getSerial(), p2pTimeouts);
                }
            })
                .catch((err) => {
                const error = (0, error_1.ensureError)(err);
                logging_1.rootHTTPLogger.debug(`Device load event image - Fallback Error`, {
                    error: (0, utils_1.getError)(error),
                    stationSN: station.getSerial(),
                    deviceSN: device.getSerial(),
                    message: JSON.stringify(message),
                });
                (0, exports.loadImageOverP2P)(station, device, device.getSerial(), p2pTimeouts);
            });
        }
        else {
            //fallback
            (0, exports.loadImageOverP2P)(station, device, device.getSerial(), p2pTimeouts);
        }
    }
};
exports.loadEventImage = loadEventImage;
const getRandomPhoneModel = function () {
    /**
     *  Generate a random phone model based on a structure
     */
    const brandKeys = Object.keys(const_1.PhoneModelStructure);
    const randomBrandName = brandKeys[Math.floor(Math.random() * brandKeys.length)];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    let part1 = "";
    let part2 = "";
    const dataBrand = const_1.PhoneModelStructure[randomBrandName];
    if (dataBrand.first && dataBrand.second) {
        part1 = pick(dataBrand.first);
        part2 = pick(dataBrand.second);
    }
    if (dataBrand.numbers && dataBrand.letters) {
        const minNum = Math.pow(10, dataBrand.numbers - 1);
        const maxNum = Math.pow(10, dataBrand.numbers) - 1;
        part1 = String(Math.floor(Math.random() * (maxNum - minNum + 1)) + minNum);
        part2 = pick(dataBrand.letters);
    }
    return `${randomBrandName}${part1}${part2}`.trim();
};
exports.getRandomPhoneModel = getRandomPhoneModel;
//# sourceMappingURL=utils.js.map