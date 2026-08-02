'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { auditPrivateDeliveryQueue } = require('../helpers/clover/privateDeliveryQueueAudit');

function write(root, relativePath, content) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
}

function fixture(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-pv-delivery-audit-'));
    write(root, 'helpers/clover/deliveryService.js', `
        async function enqueuePrivateText(db, input) {
            return db.run('INSERT INTO clover_delivery_jobs (status) VALUES (\\'pending\\')');
        }
        module.exports = { enqueuePrivateText };
    `);
    write(root, 'comandos/entregas.js', `
        async function executar(db) {
            await listRecentDeliveryJobs(db);
            await retryDeliveryJob(db, 1);
            await cancelDeliveryJob(db, 2);
        }
    `);
    if (options.consumer !== false) {
        write(root, 'helpers/clover/deliveryWorker.js', `
            async function processQueue(db, sock) {
                const job = await db.get("SELECT payload_json FROM clover_delivery_jobs WHERE status = 'pending'");
                await db.run("UPDATE clover_delivery_jobs SET status = 'processing' WHERE id = ?", job.id);
                const payload = JSON.parse(job.payload_json);
                await sendPrivateText({
                    sock,
                    playerId: job.target_jid,
                    text: payload.text,
                    ${options.policy === false ? '' : "policy: { source: payload.source, dedupeKey: job.dedupe_key },"}
                });
                await db.run("UPDATE clover_delivery_jobs SET status = 'sent' WHERE id = ?", job.id);
            }
        `);
    }
    write(root, 'tests/decoy.test.js', `
        // Testes não podem provar que existe consumidor de produção.
        const sql = "SELECT * FROM clover_delivery_jobs WHERE status = 'pending'";
        sendPrivateText({ policy: { source: 'decoy', dedupeKey: 'decoy' } });
    `);
    return root;
}

test('identifica produtor, gestão e consumidor real com política', () => {
    const root = fixture();
    try {
        const report = auditPrivateDeliveryQueue(root);
        assert.equal(report.write, false);
        assert.equal(report.summary.producerFileCount, 1);
        assert.equal(report.summary.managementFileCount, 1);
        assert.equal(report.summary.confirmedConsumerCount, 1);
        assert.equal(report.summary.policyPropagationConsumerCount, 1);
        assert.equal(report.summary.consumerMissing, false);
        assert.deepEqual(report.confirmedConsumers, ['helpers/clover/deliveryWorker.js']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('não considera teste como consumidor de produção', () => {
    const root = fixture({ consumer: false });
    try {
        const report = auditPrivateDeliveryQueue(root);
        assert.equal(report.summary.confirmedConsumerCount, 0);
        assert.equal(report.summary.consumerMissing, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('detecta consumidor sem propagação de source e dedupeKey', () => {
    const root = fixture({ policy: false });
    try {
        const report = auditPrivateDeliveryQueue(root);
        assert.equal(report.summary.confirmedConsumerCount, 1);
        assert.equal(report.summary.policyPropagationConsumerCount, 0);
        assert.equal(report.summary.policyPropagationMissing, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
