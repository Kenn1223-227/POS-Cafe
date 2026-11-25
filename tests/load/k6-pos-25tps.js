import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

/**
 * [Wave 4B — P2-01] Bộ Stress Test k6 chuẩn Scale 500 Quán (25 TPS Checkout + 200 VU POS/KDS/Report).
 *
 * Cách chạy:
 *   BASE_URL=http://127.0.0.1:3000 AUTH_TOKEN=<jwt> BRANCH_ID=CN01 TENANT_ID=DEFAULT \
 *   npm run test:load:k6
 */

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const BRANCH_ID = __ENV.BRANCH_ID || 'CN01';
const TENANT_ID = __ENV.TENANT_ID || 'DEFAULT';
const SAMPLE_ITEM_CODE = __ENV.SAMPLE_ITEM_CODE || 'SP01';

const checkoutErrorRate = new Rate('pos_checkout_errors');
const reportLatencyMs = new Trend('pos_daily_summary_ms');

export const options = {
    scenarios: {
        order_checkout_25tps: {
            executor: 'constant-arrival-rate',
            rate: 25,
            timeUnit: '1s',
            duration: '2m',
            preAllocatedVUs: 50,
            maxVUs: 150,
            exec: 'orderCheckoutFlow',
        },
        kds_pos_200vu: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '30s', target: 100 },
                { duration: '1m', target: 200 },
                { duration: '30s', target: 0 },
            ],
            gracefulRampDown: '15s',
            exec: 'kdsPosReadFlow',
        },
    },
    thresholds: {
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<500', 'p(99)<1200'],
        pos_checkout_errors: ['rate<0.01'],
    },
};

function buildHeaders(extra = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-Branch-Id': BRANCH_ID,
        'X-Tenant-Id': TENANT_ID,
        ...extra,
    };
    if (AUTH_TOKEN) {
        headers.Authorization = `Bearer ${AUTH_TOKEN}`;
    }
    return headers;
}

export function orderCheckoutFlow() {
    const idemKey = `k6-${__VU}-${__ITER}-${Date.now()}`;
    const payload = JSON.stringify({
        branchId: BRANCH_ID,
        loaiDonHang: 'MANG_DI',
        danhSachMon: [
            {
                maMon: SAMPLE_ITEM_CODE,
                kichThuoc: 'M',
                soLuong: 1,
                ghiChu: 'k6-load-test',
            },
        ],
    });

    const createRes = http.post(`${BASE_URL}/api/order`, payload, {
        headers: buildHeaders({ 'Idempotency-Key': idemKey }),
        tags: { endpoint: 'POST /api/order' },
    });

    const createOk = check(createRes, {
        'create order status 200/201': (r) => r.status === 200 || r.status === 201,
    });
    checkoutErrorRate.add(!createOk);

    // Kiểm tra lại trạng thái đơn đang mở (hoặc tra cứu mã đơn vừa tạo)
    let maHoaDon = null;
    try {
        const body = createRes.json();
        maHoaDon = body?.hoaDon?.maHoaDon || body?.maHoaDon || null;
    } catch {
        maHoaDon = null;
    }

    const statusUrl = maHoaDon
        ? `${BASE_URL}/api/hoadon/${encodeURIComponent(maHoaDon)}`
        : `${BASE_URL}/api/hoadon/dangmo`;

    const statusRes = http.get(statusUrl, {
        headers: buildHeaders(),
        tags: { endpoint: 'GET order status' },
    });
    check(statusRes, {
        'order status readable': (r) => r.status === 200,
    });
}

export function kdsPosReadFlow() {
    const headers = buildHeaders();

    const menuRes = http.get(`${BASE_URL}/api/sanpham?branchId=${encodeURIComponent(BRANCH_ID)}`, {
        headers,
        tags: { endpoint: 'GET /api/sanpham' },
    });
    check(menuRes, { 'menu 200': (r) => r.status === 200 });

    const tableRes = http.get(`${BASE_URL}/api/ban?branchId=${encodeURIComponent(BRANCH_ID)}`, {
        headers,
        tags: { endpoint: 'GET /api/ban' },
    });
    check(tableRes, { 'tables 200': (r) => r.status === 200 });

    const kdsRes = http.get(`${BASE_URL}/api/order/dangcho`, {
        headers,
        tags: { endpoint: 'GET /api/order/dangcho' },
    });
    check(kdsRes, { 'kds queue 200': (r) => r.status === 200 });

    const reportRes = http.get(
        `${BASE_URL}/api/reports/daily-summary?branchId=${encodeURIComponent(BRANCH_ID)}&limit=30`,
        {
            headers,
            tags: { endpoint: 'GET /api/reports/daily-summary' },
        }
    );
    reportLatencyMs.add(reportRes.timings.duration);
    check(reportRes, { 'daily summary 200': (r) => r.status === 200 });

    sleep(0.5);
}
