'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_MEDIA_BYTES,
    AdminMediaError,
    decodeImageDataUrl,
    detectMime,
} = require('../helpers/clover/adminMediaService');

function dataUrl(mime, bytes) {
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0,
    0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    0x00, 0x01,
]);
const WEBP = Buffer.from([
    0x52, 0x49, 0x46, 0x46,
    0x00, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
]);

test('detects supported media from bytes rather than declared extension', () => {
    assert.equal(detectMime(PNG), 'image/png');
    assert.equal(detectMime(JPEG), 'image/jpeg');
    assert.equal(detectMime(WEBP), 'image/webp');
    assert.equal(detectMime(Buffer.from('not-an-image')), null);
});

test('accepts a matching image data URL', () => {
    const decoded = decodeImageDataUrl(dataUrl('image/png', PNG));
    assert.equal(decoded.mimeType, 'image/png');
    assert.deepEqual(decoded.bytes, PNG);
});

test('rejects MIME spoofing', () => {
    assert.throws(
        () => decodeImageDataUrl(dataUrl('image/jpeg', PNG)),
        (error) => error instanceof AdminMediaError && error.code === 'media_mime_mismatch'
    );
});

test('rejects unsupported content even with image-like payload', () => {
    assert.throws(
        () => decodeImageDataUrl(dataUrl('image/png', Buffer.alloc(32, 1))),
        (error) => error instanceof AdminMediaError && error.code === 'unsupported_media'
    );
});

test('rejects processed image larger than the backend limit', () => {
    const oversized = Buffer.alloc(MAX_MEDIA_BYTES + 1, 0);
    PNG.copy(oversized, 0);
    assert.throws(
        () => decodeImageDataUrl(dataUrl('image/png', oversized)),
        (error) => error instanceof AdminMediaError && error.code === 'media_too_large' && error.status === 413
    );
});
