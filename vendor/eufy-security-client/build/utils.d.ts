import { Category } from "typescript-logging-category-style";
import EventEmitter from "events";
import { ErrorObject, EufySecurityPersistentData } from "./interfaces";
import { BaseError } from "./error";
import { PropertyMetadataAny } from "./http";
/**
 *  Get error structure from error object
 * @param error
 */
export declare const getError: (error: BaseError) => ErrorObject;
/**
 *  Remove last character from the string given
 *
 * @param text
 * @param char
 */
export declare const removeLastChar: (text: string, char: string) => string;
/**
 *  Generate a UDID
 */
export declare const generateUDID: () => string;
/**
 * Generate a random serial number
 * @param length
 */
export declare const generateSerialnumber: (length: number) => string;
/**
 *  Generate md5 from a given string
 *
 * @param contents
 */
export declare const md5: (contents: string) => string;
export declare const handleUpdate: (config: EufySecurityPersistentData, oldVersion: number) => EufySecurityPersistentData;
/**
 *  Checking if a string is empty
 *
 *  TODO: shouldnt you do a trim to remove any spaces too?
 *
 * @param str
 */
export declare const isEmpty: (str: string | null | undefined) => boolean;
/**
 *  Try to parse the value as boolean otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
export declare const parseValueBoolean: (metadata: PropertyMetadataAny, value: unknown) => boolean;
/**
 * Try to parse the value as number otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
export declare const parseValueNumber: (metadata: PropertyMetadataAny, value: unknown) => Number;
/**
 * Try to parse the value as string otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
export declare const parseValueString: (metadata: PropertyMetadataAny, value: unknown) => string;
/**
 * Try to parse the value as object otherwise raise and exception
 *
 * @param metadata
 * @param value
 */
export declare const parseValueObject: (metadata: PropertyMetadataAny, value: unknown) => any;
/**
 *  Parse the value given to match the metadata from the propperty
 * @param metadata
 * @param value
 */
export declare const parseValue: (metadata: PropertyMetadataAny, value: unknown) => unknown;
/**
 * Parse data as json otherwise return undefined
 *
 * @param data
 * @param log
 */
export declare const parseJSON: (data: string, log: Category) => any;
/**
 * Validate the value based on the metadata property
 *
 * @param metadata
 * @param value
 */
export declare const validValue: (metadata: PropertyMetadataAny, value: unknown) => void;
/**
 *
 * @param target
 * @param source
 */
export declare const mergeDeep: (target: Record<string, any> | undefined, source: Record<string, any>) => Record<string, any>;
/**
 *
 * @param emitter
 * @param event
 */
export declare function waitForEvent<T>(emitter: EventEmitter, event: string): Promise<T>;
/**
 * Get short url from given url and ensure password is reeducated
 *
 * @param url
 * @param prefixUrl
 */
export declare function getShortUrl(url: URL, prefixUrl?: string): string;
/**
 *  Check if it is a valid url
 *
 * @param value
 * @param protocols
 */
export declare function isValidUrl(value: string, protocols?: Array<string>): boolean;
