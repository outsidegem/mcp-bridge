export function validateSchema(args: any, schema: any): boolean {
    if (schema === undefined || schema === null) return true;
    if (args === undefined) return false;

    if (schema.type === 'object') {
        if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
        if (schema.required && Array.isArray(schema.required)) {
            for (const req of schema.required) {
                if (!(req in args)) return false;
            }
        }
        if (schema.additionalProperties === false) {
            for (const key in args) {
                if (!schema.properties || !(key in schema.properties)) return false;
            }
        }
        if (schema.properties) {
            for (const key in schema.properties) {
                if (key in args) {
                    if (!validateSchema(args[key], schema.properties[key])) return false;
                }
            }
        }
        return true;
    } else if (schema.type === 'array') {
        if (!Array.isArray(args)) return false;
        if (schema.items) {
            for (const item of args) {
                if (!validateSchema(item, schema.items)) return false;
            }
        }
        return true;
    } else if (schema.type === 'string') {
        if (typeof args !== 'string') return false;
        if (schema.enum && !schema.enum.includes(args)) return false;
        return true;
    } else if (schema.type === 'number') {
        if (typeof args !== 'number') return false;
        if (schema.enum && !schema.enum.includes(args)) return false;
        return true;
    } else if (schema.type === 'boolean') {
        if (typeof args !== 'boolean') return false;
        return true;
    }
    return true;
}
