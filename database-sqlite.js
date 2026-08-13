/**
 * LEILÃO FÁCIL v2.0 - Selector de Banco de Dados
 * Usa PostgreSQL (Supabase) em produção, SQLite local em desenvolvimento
 */

if (process.env.DATABASE_URL) {
  console.log('💾 Usando PostgreSQL (Supabase) em produção');
  module.exports = require('./database-pg');
} else {
  console.log('💾 Usando SQLite (local) em desenvolvimento');
  const sqliteDb = require('./database-sqlite');

  // Wrap SQLite sync functions in async promises for uniform API
  const wrapped = { db: sqliteDb.db };
  for (const key of Object.keys(sqliteDb)) {
    if (key === 'db') continue;
    const fn = sqliteDb[key];
    if (typeof fn === 'function') {
      wrapped[key] = async (...args) => fn(...args);
    } else {
      wrapped[key] = fn;
    }
  }
  module.exports = wrapped;
}
