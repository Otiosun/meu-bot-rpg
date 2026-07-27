'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    pseudonymizePlayerId,
    sanitizeTraitDescriptionAuditReport,
} = require('../helpers/clover/traitDescriptionAuditPrivacy');

test('gera pseudônimo estável sem preservar o identificador bruto', () => {
    const rawId = '557999999999@s.whatsapp.net';
    const first = pseudonymizePlayerId(rawId);
    const second = pseudonymizePlayerId(rawId);

    assert.equal(first, second);
    assert.match(first, /^P-[A-F0-9]{12}$/);
    assert.equal(first.includes('5579'), false);
});

test('remove playerId de todos os candidatos do relatório', () => {
    const report = sanitizeTraitDescriptionAuditReport({
        summary: { templatesMissingDescription: 1 },
        templates: [{
            id: 'TR-1',
            name: 'Traço',
            candidates: [{
                source: 'historias_extras',
                confidence: 'high',
                description: 'Texto.',
                playerId: '557999999999@s.whatsapp.net',
                characterName: 'Personagem',
            }],
        }],
    });

    const candidate = report.templates[0].candidates[0];
    assert.equal(Object.hasOwn(candidate, 'playerId'), false);
    assert.match(candidate.playerKey, /^P-[A-F0-9]{12}$/);
    assert.equal(candidate.characterName, 'Personagem');
    assert.deepEqual(report.privacy, {
        playerIds: 'sha256-prefix',
        rawPlayerIdsIncluded: false,
        phoneNumbersIncluded: false,
        sessionsIncluded: false,
        loginCodesIncluded: false,
    });
});

test('não cria chave fictícia quando não existe jogador ligado', () => {
    const report = sanitizeTraitDescriptionAuditReport({
        templates: [{
            id: 'TR-1',
            candidates: [{ source: 'catalog_sibling', description: 'Texto.' }],
        }],
    });

    assert.equal(report.templates[0].candidates[0].playerKey, null);
});
