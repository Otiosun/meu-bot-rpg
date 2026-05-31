const COMMAND_PREFIX = '.#';
const DEVO_PREFIX = '#devo';
const MAX_PLAYER_ROLLS = 4;
const ENABLE_LEGACY_BC = process.env.ENABLE_LEGACY_BC === '1';

module.exports = {
    COMMAND_PREFIX,
    DEVO_PREFIX,
    ENABLE_LEGACY_BC,
    MAX_PLAYER_ROLLS,
};
