'use strict';

const {
    pseudonymizePlayerId,
    sanitizeCandidate,
    sanitizeTraitDescriptionAuditReport,
} = require('./traitDescriptionAuditPrivacy');

module.exports = {
    playerKey: pseudonymizePlayerId,
    pseudonymizePlayerId,
    sanitizeCandidate,
    sanitizeTraitDescriptionAuditReport,
};
