import { Category } from "typescript-logging-category-style";
export declare class ParameterHelper {
    private static readonly JSON_PARSE_BASE64_PARAMS;
    private static readonly JSON_PARSE_PLAIN_PARAMS;
    static readValue(serialNumber: string, type: number, value: string, log: Category): string | undefined;
    static writeValue(type: number, value: string): string;
}
