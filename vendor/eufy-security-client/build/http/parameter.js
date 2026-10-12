"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParameterHelper = void 0;
const p2p_1 = require("../p2p");
const utils_1 = require("../p2p/utils");
const utils_2 = require("../utils");
const types_1 = require("./types");
const utils_3 = require("./utils");
const error_1 = require("../error");
class ParameterHelper {
    static JSON_PARSE_BASE64_PARAMS = new Set([
        types_1.ParamType.SNOOZE_MODE,
        types_1.ParamType.CAMERA_MOTION_ZONES,
        p2p_1.CommandType.CMD_SET_DOORSENSOR_ALWAYS_OPEN_DELAY,
        p2p_1.CommandType.CMD_SET_DOORSENSOR_ALWAYS_OPEN,
        p2p_1.CommandType.ARM_DELAY_HOME,
        p2p_1.CommandType.ARM_DELAY_AWAY,
        p2p_1.CommandType.ARM_DELAY_CUS1,
        p2p_1.CommandType.ARM_DELAY_CUS2,
        p2p_1.CommandType.ARM_DELAY_CUS3,
        p2p_1.CommandType.ARM_DELAY_OFF,
        p2p_1.CommandType.CELLULAR_INFO,
        p2p_1.CommandType.CMD_WALL_LIGHT_SETTINGS_MANUAL_COLORED_LIGHTING,
        p2p_1.CommandType.CMD_WALL_LIGHT_SETTINGS_SCHEDULE_COLORED_LIGHTING,
        p2p_1.CommandType.CMD_WALL_LIGHT_SETTINGS_COLORED_LIGHTING_COLORS,
        p2p_1.CommandType.CMD_WALL_LIGHT_SETTINGS_DYNAMIC_LIGHTING_THEMES,
        p2p_1.CommandType.CMD_INDOOR_DET_SET_ACTIVE_ZONE,
        p2p_1.CommandType.CMD_SET_PRIVACYPARAM,
        p2p_1.CommandType.CMD_BAT_DOORBELL_VIDEO_QUALITY2,
        p2p_1.CommandType.CMD_BAT_DOORBELL_RECORD_QUALITY2,
        p2p_1.CommandType.CMD_SET_CROSS_TRACKING_CAMERA_LIST,
        p2p_1.CommandType.CMD_SET_CROSS_TRACKING_GROUP_LIST,
        p2p_1.CommandType.CMD_FLOODLIGHT_SET_DETECTION_RANGE_T8425,
        p2p_1.CommandType.CMD_SET_LIGHT_CTRL_BRIGHT_PIR_T8425,
        p2p_1.CommandType.CMD_SET_LIGHT_CTRL_BRIGHT_SCH_T8425,
    ]);
    static JSON_PARSE_PLAIN_PARAMS = new Set([
        p2p_1.CommandType.CMD_BAT_DOORBELL_SET_NOTIFICATION_MODE,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_RADAR_WD_DETECTION_SENSITIVITY,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_RADAR_WD_AUTO_RESPONSE,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_PACKAGE_STRAND_TIME,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_RING_AUTO_RESPONSE,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_PACKAGE_GUARD_TIME,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_RADAR_WD_DISTANCE,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_RADAR_WD_TIME,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_DELIVERY_GUARD_SWITCH,
        p2p_1.CommandType.CMD_DOORBELL_DUAL_PACKAGE_GUARD_VOICE,
        p2p_1.CommandType.CMD_CAMERA_GARAGE_DOOR_SENSORS,
        p2p_1.CommandType.CMD_MOTION_SET_LEAVING_REACTIONS,
    ]);
    static readValue(serialNumber, type, value, log) {
        if (value) {
            // TODO: investigate why the value can be a object
            //
            //if (typeof value !== "string") return value;
            if (typeof value !== "string") {
                log.debug("Watch out for this object! .", {
                    value: JSON.stringify(value, null, 2),
                });
                return value;
            }
            if (ParameterHelper.JSON_PARSE_BASE64_PARAMS.has(type)) {
                const parsedValue = (0, utils_2.parseJSON)((0, utils_1.getNullTerminatedString)((0, utils_1.decodeBase64)(value), "utf-8"), log);
                if (parsedValue === undefined) {
                    log.debug("Non-parsable parameter value received from eufy cloud. Will be ignored.", {
                        serialNumber: serialNumber,
                        type: type,
                        value: value,
                    });
                }
                return parsedValue;
            }
            else if (ParameterHelper.JSON_PARSE_PLAIN_PARAMS.has(type)) {
                const parsedValue = (0, utils_2.parseJSON)(value, log);
                if (parsedValue === undefined) {
                    log.debug("Non-parsable parameter value received from eufy cloud. Will be ignored.", {
                        serialNumber: serialNumber,
                        type: type,
                        value: value,
                    });
                }
                return parsedValue;
            }
            else if (type === p2p_1.TrackerCommandType.COMMAND_NEW_LOCATION || type === p2p_1.TrackerCommandType.LOCATION_NEW_ADDRESS) {
                try {
                    const decrypted = (0, utils_3.decryptTrackerData)(Buffer.from(value, "hex"), Buffer.from(serialNumber));
                    if (decrypted !== undefined) {
                        return decrypted.toString("utf8").trim();
                    }
                }
                catch (err) {
                    const error = (0, error_1.ensureError)(err);
                    log.debug("Non-parsable parameter value received from eufy cloud. Will be ignored.", {
                        serialNumber: serialNumber,
                        type: type,
                        value: value,
                        error: (0, utils_2.getError)(error),
                    });
                }
                return "";
            }
        }
        return value;
    }
    static writeValue(type, value) {
        if (value) {
            if (type === types_1.ParamType.SNOOZE_MODE ||
                type === types_1.ParamType.CAMERA_MOTION_ZONES ||
                type === p2p_1.CommandType.CMD_SET_DOORSENSOR_ALWAYS_OPEN_DELAY ||
                type === p2p_1.CommandType.CMD_SET_DOORSENSOR_ALWAYS_OPEN) {
                return Buffer.from(JSON.stringify(value)).toString("base64");
            }
            return value;
        }
        return "";
    }
}
exports.ParameterHelper = ParameterHelper;
//# sourceMappingURL=parameter.js.map