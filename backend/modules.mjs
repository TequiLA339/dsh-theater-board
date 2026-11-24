import invoice from './modules/invoice/index.mjs';
import movement from './modules/movement/index.mjs';
import opening from './modules/opening/index.mjs';
import terminal from './modules/terminal/index.mjs';
import inventory from './modules/inventory/index.mjs';
import banquet from './modules/banquet/index.mjs';
import target from './modules/target/index.mjs';

// Shared registration only. Module branches edit their own directory.
export const moduleDefinitions = [invoice, movement, opening, terminal, inventory, banquet, target];
export const moduleById = new Map(moduleDefinitions.map(module => [module.id, module]));
export { normalizeHeader } from './recognition/headers.mjs';
