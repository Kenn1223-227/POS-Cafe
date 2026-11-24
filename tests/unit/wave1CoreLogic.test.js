const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { kiemTraVaTangVersionHoaDon } = require('../../modules/fohEngineService');

class FakeLoiNghiepVu extends Error {
    constructor(status, message, details = null) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

describe('Wave 1 Unit — Mandatory Optimistic Locking (P0-01) & Multi-Tenant Staff Cache (P0-04)', () => {
    it('kiemTraVaTangVersionHoaDon trả 428 EXPECTED_VERSION_REQUIRED khi thiếu expectedVersion', async () => {
        const fakeClient = { query: async () => ({ rows: [] }) };
        await assert.rejects(
            () =>
                kiemTraVaTangVersionHoaDon(fakeClient, {
                    maHoaDon: 'HD_TEST_1',
                    tenantId: 'TENANT_A',
                    expectedVersion: null,
                    LoiNghiepVu: FakeLoiNghiepVu,
                }),
            (err) => {
                assert.equal(err.status, 428);
                assert.equal(err.details?.code, 'EXPECTED_VERSION_REQUIRED');
                return true;
            }
        );
    });

    it('kiemTraVaTangVersionHoaDon trả 409 ORDER_CONCURRENT_MODIFIED khi version bị thiết bị khác cập nhật trước', async () => {
        const fakeClient = {
            query: async (sql) => {
                if (/UPDATE HoaDon/i.test(sql)) return { rows: [] };
                return { rows: [] };
            },
        };
        await assert.rejects(
            () =>
                kiemTraVaTangVersionHoaDon(fakeClient, {
                    maHoaDon: 'HD_TEST_2',
                    tenantId: 'TENANT_A',
                    expectedVersion: 1,
                    layHoaDonChiTiet: async () => ({ maHoaDon: 'HD_TEST_2', version: 2 }),
                    LoiNghiepVu: FakeLoiNghiepVu,
                }),
            (err) => {
                assert.equal(err.status, 409);
                assert.equal(err.details?.code, 'ORDER_CONCURRENT_MODIFIED');
                assert.equal(err.details?.currentVersion, 2);
                return true;
            }
        );
    });
});
