// Keep requiredHeaders available to the existing upload UI and stored contracts.
export function defineModule(definition) {
  return { ...definition, requiredHeaders: definition.fields.map(field => field.header) };
}
