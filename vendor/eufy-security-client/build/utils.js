"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeDeep = exports.validValue = exports.parseJSON = exports.parseValue = exports.parseValueObject = exports.parseValueString = exports.parseValueNumber = exports.parseValueBoolean = exports.isEmpty = exports.handleUpdate = exports.md5 = exports.generateSerialnumber = exports.generateUDID = exports.removeLastChar = exports.getError = void 0;
exports.waitForEvent = waitForEvent;
exports.getShortUrl = getShortUrl;
exports.isValidUrl = isValidUrl;
const crypto = __importStar(require("crypto"));
const error_1 = require("./error");
/**
 *  Get error structure from error object
 * @param error
 */
const getError = function (error) {
    return {
        cause: error.cause,
        message: `${error.name}: ${error.message}`,
        context: error.context,
        stacktrace: error.stack,
    };
};
exports.getError = getError;
/**
 *  Remove last character from the string given
 *
 * @param text
 * @param char
 */
const removeLastChar = function (text, char) {
    const strArr = [...text];
    strArr.splice(text.lastIndexOf(char), 1);
    return strArr.join("");
};
exports.removeLastChar = removeLastChar;
/**
 *  Generate a UDID
 */
const generateUDID = function () {
    return crypto.randomBytes(8).readBigUInt64BE().toString(16).padStart(16, "0");
};
exports.generateUDID = generateUDID;
/**
 * Generate a random serial number
 * @param length
 */
const generateSerialnumber = function (length) {
    return crypto.randomBytes(length / 2).toString("hex");
};
exports.generateSerialnumber = generateSerialnumber;
/**
 *  Generate md5 from a given string
 *
 * @param contents
 */
const md5 = (contents) => crypto.createHash("md5").update(contents).digest("hex");
exports.md5 = md5;
const handleUpdate = function (config, oldVersion) {
    if (oldVersion <= 1.24) {
        config.cloud_token = "";
        config.cloud_token_expiration = 0;
    }
    return config;
};
exports.handleUpdate = handleUpdate;
/**
 *  Checking if a string is empty
 *
 *  TODO: shouldnt you do a trim to remove any spaces too?
 *
 * @param str
 */
const isEmpty = function (str) {
    if (str) {
        if (str.length > 0)
            return false;
        return true;
    }
    return true;
};
exports.isEmpty = isEmpty;
/**
 *  Try to parse the value as boolean otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
const parseValueBoolean = (metadata, value) => {
    let successParsing = false;
    let parsedValue = false;
    switch (typeof value) {
        case "boolean":
            successParsing = true;
            parsedValue = value;
            break;
        case "number":
            if (value === 0 || value === 1) {
                parsedValue = value === 1;
                successParsing = true;
            }
            break;
        case "string":
            if (value.toLowerCase() === "true" || value.toLowerCase() === "false") {
                parsedValue = value.toLowerCase() === "true";
                successParsing = true;
            }
            break;
        default:
            break;
    }
    if (!successParsing) {
        throw new error_1.InvalidPropertyValueError("Property expects a boolean value", {
            context: {
                propertyName: metadata.name,
                propertyValue: value,
                metadata: metadata,
            },
        });
    }
    return parsedValue;
};
exports.parseValueBoolean = parseValueBoolean;
/**
 * Try to parse the value as number otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
const parseValueNumber = (metadata, value) => {
    let successParsing = false;
    let parsedValue = 0;
    let causeError = undefined;
    switch (typeof value) {
        case "number":
            successParsing = true;
            parsedValue = value;
            break;
        case "string":
            try {
                parsedValue = Number.parseInt(value);
                // Ensure the value is not an invalid number
                if (!isNaN(parsedValue))
                    successParsing = true;
            }
            catch (err) {
                causeError = (0, error_1.ensureError)(err);
            }
            break;
        default:
            break;
    }
    if (!successParsing) {
        throw new error_1.InvalidPropertyValueError("Property expects a number value", {
            cause: causeError,
            context: {
                propertyName: metadata.name,
                propertyValue: value,
                metadata: metadata,
            },
        });
    }
    return parsedValue;
};
exports.parseValueNumber = parseValueNumber;
/**
 * Try to parse the value as string otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
const parseValueString = (metadata, value) => {
    let successParsing = false;
    let parsedValue = "";
    switch (typeof value) {
        case "number":
            successParsing = true;
            parsedValue = value.toString();
            break;
        case "string":
            successParsing = true;
            parsedValue = value;
            break;
        case "boolean":
            successParsing = true;
            parsedValue = value ? "true" : "false";
            break;
        default:
            break;
    }
    if (!successParsing) {
        throw new error_1.InvalidPropertyValueError("Property expects a string value", {
            context: {
                propertyName: metadata.name,
                propertyValue: value,
                metadata: metadata,
            },
        });
    }
    return parsedValue;
};
exports.parseValueString = parseValueString;
/**
 * Try to parse the value as object otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
const parseValueObject = (metadata, value) => {
    if (value === null) {
        throw new error_1.InvalidPropertyValueError("Property expects an object value", {
            context: {
                propertyName: metadata.name,
                propertyValue: value,
                metadata: metadata,
            },
        });
    }
    return value;
};
exports.parseValueObject = parseValueObject;
/**
 *  Parse the value given to match the metadata from the propperty
 * @param metadata
 * @param value
 */
const parseValue = function (metadata, value) {
    let parsedValue;
    if (value === undefined) {
        throw new error_1.InvalidPropertyValueError(`Property expects a ${metadata.type} value`, {
            context: {
                propertyName: metadata.name,
                propertyValue: value,
                metadata: metadata,
            },
        });
    }
    if (metadata.type === "boolean") {
        parsedValue = (0, exports.parseValueBoolean)(metadata, value);
    }
    else if (metadata.type === "number") {
        parsedValue = (0, exports.parseValueNumber)(metadata, value);
    }
    else if (metadata.type === "string") {
        parsedValue = (0, exports.parseValueString)(metadata, value);
    }
    else if (metadata.type === "object") {
        parsedValue = (0, exports.parseValueObject)(metadata, value);
    }
    else {
        throw new error_1.InvalidPropertyValueError(`Property expects a ${metadata.type} value`, {
            context: {
                propertyName: metadata.name,
                propertyValue: value,
                metadata: metadata,
            },
        });
    }
    return parsedValue;
};
exports.parseValue = parseValue;
/**
 * Parse data as json otherwise return undefined
 *
 * @param data
 * @param log
 */
const parseJSON = function (data, log) {
    try {
        return JSON.parse(data.replace(/[\0]+$/g, ""));
    }
    catch (err) {
        const error = (0, error_1.ensureError)(err);
        log.debug("JSON parse error", { error: (0, exports.getError)(error), data: data });
    }
    return undefined;
};
exports.parseJSON = parseJSON;
/**
 * Validate the value based on the metadata property
 *
 * @param metadata
 * @param value
 */
const validValue = function (metadata, value) {
    let isValidData = true;
    if (metadata.type === "number") {
        const numberMetadata = metadata;
        const numericValue = Number(value);
        if ((numberMetadata.min !== undefined && numberMetadata.min > numericValue) ||
            (numberMetadata.max !== undefined && numberMetadata.max < numericValue) ||
            (numberMetadata.states !== undefined && numberMetadata.states[numericValue] === undefined) ||
            Number.isNaN(numericValue))
            isValidData = false;
    }
    else if (metadata.type === "string") {
        const stringMetadata = metadata;
        const stringValue = String(value);
        if ((stringMetadata.format !== undefined && stringValue.match(stringMetadata.format) === null) ||
            (stringMetadata.minLength !== undefined && stringMetadata.minLength > stringValue.length) ||
            (stringMetadata.maxLength !== undefined && stringMetadata.maxLength < stringValue.length))
            isValidData = false;
    }
    else if (metadata.type === "boolean") {
        const str = String(value).toLowerCase().trim();
        if (str !== "true" && str !== "false" && str !== "1" && str !== "0")
            isValidData = false;
    }
    else if (metadata.type === "object") {
        const metadataObject = metadata;
        if (value !== undefined && value !== null && metadataObject.isValidObject !== undefined)
            isValidData = metadataObject.isValidObject(value);
    }
    else {
        isValidData = false;
    }
    if (!isValidData) {
        throw new error_1.InvalidPropertyValueError(`Invalid value for this property according to metadata type ${metadata.type}`, {
            context: {
                propertyName: metadata.name,
                propertyValue: value,
                metadata: metadata,
            },
        });
    }
};
exports.validValue = validValue;
/**
 *
 * @param target
 * @param source
 */
const mergeDeep = function (target, source) {
    target = target || {};
    for (const [key, value] of Object.entries(source)) {
        if (!(key in target)) {
            target[key] = value;
        }
        else {
            if (typeof value === "object") {
                // merge objects
                target[key] = (0, exports.mergeDeep)(target[key], value);
            }
            else if (typeof target[key] === "undefined") {
                // don't override single keys
                target[key] = value;
            }
        }
    }
    return target;
};
exports.mergeDeep = mergeDeep;
/**
 *
 * @param emitter
 * @param event
 */
function waitForEvent(emitter, event) {
    return new Promise((resolve, reject) => {
        const success = (val) => {
            emitter.off("error", fail);
            resolve(val);
        };
        const fail = (err) => {
            emitter.off(event, success);
            reject(err);
        };
        emitter.once(event, success);
        emitter.once("error", fail);
    });
}
/**
 * Get short url from given url and ensure password is reeducated
 *
 * @param url
 * @param prefixUrl
 */
function getShortUrl(url, prefixUrl) {
    if (url.password) {
        url = new URL(url.toString()); // prevent original url mutation
        url.password = "[redacted]";
    }
    let shortUrl = url.toString();
    if (prefixUrl && shortUrl.startsWith(prefixUrl)) {
        shortUrl = shortUrl.slice(prefixUrl.length);
    }
    return shortUrl;
}
/**
 *  Check if it is a valid url
 *
 * @param value
 * @param protocols
 */
function isValidUrl(value, protocols = ["http", "https"]) {
    try {
        const url = new URL(value);
        return protocols
            ? url.protocol
                ? protocols.map((protocol) => `${protocol.toLowerCase()}:`).includes(url.protocol)
                : false
            : true;
    }
    catch (_) {
        return false;
    }
}
//# sourceMappingURL=utils.js.map