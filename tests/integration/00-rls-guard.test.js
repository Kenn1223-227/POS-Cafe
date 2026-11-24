const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const {
    getRuntimeConnectionString,
    createRuntimePool,
    assertAppRuntimeNoBypassRls,
} = require('../helpers/dbHarness');

const HAS_DB = Boolean(getRuntimeConnectionString());

describe('Wave 1 Integration [00] — Guard Bắt Buộc app_runtime (NOBYPASSRLS) & Schema Migrations 027–029', { skip: !HAS_DB ? 'Chưa cấu hình TEST_APP_RUNTIME_URL (.env.test)' : false }, () => {
    let pool;

    after(async () => {
        if (pool) await pool.end();
    });

    it('BẮT BUỘC chạy dưới role non-superuser có rolbypassrls === false', async () => {
        pool = createRuntimePool();
        const role = await assertAppRuntimeNoBypassRls(pool);
        assert.equal(role.rolbypassrls, false);
    });

    it('xác nhận FORCE ROW LEVEL SECURITY, PK combo (tenantid, macombo), unique index chamcong và trigger FSM tồn tại', async () => {
        const rlsRes = await pool.query(`
            SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relname = ANY(ARRAY['hoadon','chitiethoadon','branch_daily_counter','vietqr_webhook_events','chamcong','combo'])
        `);
        for (const row of rlsRes.rows) {
            assert.equal(row.relrowsecurity, true, `Bảng ${row.relname} phải bật ENABLE RLS`);
            assert.equal(row.relforcerowsecurity, true, `Bảng ${row.relname} phải bật FORCE RLS`);
        }

        const comboPkRes = await pool.query(`
            SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS pk_cols
              FROM pg_constraint c
              JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             WHERE c.conrelid = 'public.combo'::regclass
               AND c.contype = 'p'
        `);
        assert.equal(comboPkRes.rows[0]?.pk_cols, 'tenantid,macombo');

        const idxRes = await pool.query(
            `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_chamcong_single_per_phanca'`
        );
        assert.equal(idxRes.rows.length, 1, 'Phải tồn tại unique index uq_chamcong_single_per_phanca');

        const trgRes = await pool.query(
            `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_hoadon_fsm' AND NOT tgisinternal`
        );
        assert.equal(trgRes.rows.length, 1, 'Phải tồn tại trigger trg_guard_hoadon_fsm');
    });
});
