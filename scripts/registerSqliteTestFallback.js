'use strict';

const Module = require('node:module');

let nativeDependenciesAvailable = true;
try {
    require.resolve('sqlite3');
    require.resolve('sqlite');
} catch {
    nativeDependenciesAvailable = false;
}

if (!nativeDependenciesAvailable) {
    const { DatabaseSync } = require('node:sqlite');
    const originalLoad = Module._load;

    class TestDriver {}

    function createAsyncAdapter(filename) {
        if (String(filename || ':memory:') !== ':memory:') {
            throw new Error('O fallback SQLite de testes aceita somente bancos em memória.');
        }
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return {
                    changes: Number(result.changes || 0),
                    lastID: Number(result.lastInsertRowid || 0),
                };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    }

    Module._load = function loadSqliteTestFallback(request, parent, isMain) {
        if (request === 'sqlite3') {
            return {
                Database: TestDriver,
                verbose: () => ({ Database: TestDriver }),
            };
        }
        if (request === 'sqlite') {
            return {
                open: async (options = {}) => createAsyncAdapter(options.filename),
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
}
