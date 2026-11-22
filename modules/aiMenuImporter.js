// AI Menu Importer: Hỗ trợ bóc tách ảnh chụp Menu giấy qua Gemini Vision API (khi có GEMINI_API_KEY)
// VÀ bộ phân tích thông minh nội sinh (Smart Local Parser) cho văn bản / Excel / CSV / GrabFood không cần API key!

function doanNhomMon(tenMon) {
    const s = String(tenMon || '').toLowerCase();
    if (/cà phê|ca phe|coffee|espresso|latte|americano|bạc xỉu|bac xiu|cold brew|cappuccino|mocha|phin/.test(s)) return 'Cà phê';
    if (/trà sữa|tra sua|oolong sữa|hồng trà sữa|trân châu|macchiato/.test(s)) return 'Trà sữa';
    if (/trà |tra |đào|vải|dâu|ổi|chanh|tắc|nhiệt đới|mãng cầu/.test(s)) return 'Trà trái cây';
    if (/matcha|houjicha|cacao|sô cô la|chocolate/.test(s)) return 'Matcha & Cacao';
    if (/đá xay|freeze|smoothie|sinh tố|yogurt|sữa chua/.test(s)) return 'Đá xay & Sữa chua';
    if (/ép|cam tươi|dưa hấu|thơm|dứa|cóc/.test(s)) return 'Nước ép';
    if (/bánh|croissant|tiramisu|cheese|mousse|cookie|pastry/.test(s)) return 'Bánh ngọt';
    return 'Đồ uống';
}

function parseGia(raw) {
    if (raw === undefined || raw === null) return null;
    const str = String(raw).trim().toLowerCase().replace(/đ|vnd|vnđ|\s+/g, '');
    if (!str) return null;
    if (/^\d+([.,]\d+)?k$/.test(str)) {
        const num = parseFloat(str.replace('k', '').replace(',', '.'));
        return Math.round(num * 1000);
    }
    const digits = str.replace(/[.,]/g, '');
    const val = parseInt(digits, 10);
    if (Number.isNaN(val) || val <= 0) return null;
    return val < 500 ? val * 1000 : val;
}

function chuanHoaDanhSachMon(items) {
    const seen = new Set();
    return items
        .map((it, idx) => {
            const tenMon = String(it.tenMon || it.name || '').trim().slice(0, 120);
            if (!tenMon) return null;
            const nhomMon = String(it.nhomMon || it.category || '').trim() || doanNhomMon(tenMon);
            const gS = parseGia(it.giaS ?? it.priceS ?? it.price) || 29000;
            const gM = parseGia(it.giaM ?? it.priceM) || Math.round((gS + 6000) / 1000) * 1000;
            const gL = parseGia(it.giaL ?? it.priceL) || Math.round((gM + 6000) / 1000) * 1000;

            let maMon = String(it.maMon || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
            if (!maMon) maMon = `AI${String(idx + 1).padStart(2, '0')}`;
            while (seen.has(maMon)) maMon = `${maMon}_${idx}`;
            seen.add(maMon);

            return {
                maMon,
                tenMon,
                nhomMon,
                giaS: gS,
                giaM: gM,
                giaL: gL,
            };
        })
        .filter(Boolean);
}

// Bộ phân tích văn bản / CSV / Menu dán từ Zalo/Excel chạy ngay 0ms
function parseMenuFromTextLocal(rawText) {
    const lines = String(rawText || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length >= 3);

    let currentGroup = '';
    const extracted = [];

    for (const line of lines) {
        // Dòng tiêu đề nhóm (VD: "=== CÀ PHÊ ===" hoặc "TRÀ TRÁI CÂY:") không chứa giá số
        if (!/\d{2,}/.test(line) && line.length <= 40) {
            currentGroup = line.replace(/^[#\-=*•\s]+|[:\-=*]+$/g, '').trim();
            continue;
        }

        // Hỗ trợ định dạng CSV / Tab: Tên món, Nhóm, Giá S, Giá M, Giá L
        const csvCols = line.includes('\t') ? line.split('\t') : line.split(',');
        if (csvCols.length >= 2 && /\d/.test(csvCols[csvCols.length - 1])) {
            const ten = csvCols[0].trim();
            const nums = csvCols.slice(1).map((c) => parseGia(c)).filter(Boolean);
            const nonNumCat = csvCols.slice(1).find((c) => !parseGia(c) && c.trim().length > 1)?.trim();
            if (ten && nums.length > 0) {
                extracted.push({
                    tenMon: ten,
                    nhomMon: nonNumCat || currentGroup || doanNhomMon(ten),
                    giaS: nums[0],
                    giaM: nums[1] || undefined,
                    giaL: nums[2] || undefined,
                });
                continue;
            }
        }

        // Định dạng tự do: "Cà phê sữa đá - 29k / 35k / 39k" hoặc "Trà đào cam sả 45.000đ"
        const priceMatches = [...line.matchAll(/(\d+(?:[.,]\d{3})+|\d+(?:[.,]\d+)?k|\b\d{2,3}\s*(?:đ|vnd)\b)/gi)];
        const prices = priceMatches.map((m) => parseGia(m[1])).filter(Boolean);
        if (prices.length === 0) continue;

        const firstPriceIdx = priceMatches[0].index;
        const tenMon = line
            .slice(0, firstPriceIdx)
            .replace(/^[\d.)\-•*\s]+/, '')
            .replace(/[:\-–—/|]+$/, '')
            .trim();

        if (tenMon.length >= 2) {
            extracted.push({
                tenMon,
                nhomMon: currentGroup || doanNhomMon(tenMon),
                giaS: prices[0],
                giaM: prices[1] || undefined,
                giaL: prices[2] || undefined,
            });
        }
    }

    return chuanHoaDanhSachMon(extracted);
}

// Gọi Gemini Vision / Text API khi có cấu hình GEMINI_API_KEY
async function parseMenuWithGemini({ imageBase64, mimeType = 'image/jpeg', rawText = '' }) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const parts = [
        {
            text:
                'Bạn là chuyên gia số hóa thực đơn quán cà phê/trà sữa Việt Nam. ' +
                'Hãy trích xuất TẤT CẢ các món ăn/đồ uống từ ảnh hoặc văn bản sau thành mảng JSON hợp lệ (KHÔNG giải thích thêm, chỉ trả JSON array): ' +
                '[{"tenMon":"Tên món","nhomMon":"Nhóm món","giaS":29000,"giaM":35000,"giaL":42000}]. ' +
                'Nếu món chỉ có 1 giá thì điền giaS = giá đó, giaM = giaS + 6000, giaL = giaM + 6000 (bánh ngọt thì 3 size bằng nhau).',
        },
    ];

    if (rawText && rawText.trim()) {
        parts.push({ text: `Văn bản thực đơn:\n${rawText.slice(0, 8000)}` });
    }
    if (imageBase64) {
        const cleanB64 = String(imageBase64).replace(/^data:[^;]+;base64,/, '');
        parts.push({
            inline_data: {
                mime_type: mimeType,
                data: cleanB64,
            },
        });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Gemini API trả mã lỗi ${response.status}`);
    }

    const json = await response.json();
    const textOut = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleaned = textOut.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return chuanHoaDanhSachMon(parsed);
}

async function parseMenuUniversal({ imageBase64, mimeType, rawText }) {
    if (process.env.GEMINI_API_KEY && (imageBase64 || rawText)) {
        try {
            const aiItems = await parseMenuWithGemini({ imageBase64, mimeType, rawText });
            if (aiItems && aiItems.length > 0) {
                return { engine: 'GEMINI_VISION_AI', items: aiItems };
            }
        } catch (err) {
            console.warn('⚠️ Gemini Vision tạm lỗi, chuyển sang Smart Local Parser:', err.message);
        }
    }

    if (rawText && rawText.trim()) {
        return { engine: 'SMART_LOCAL_PARSER', items: parseMenuFromTextLocal(rawText) };
    }

    return {
        engine: 'NEEDS_API_KEY',
        items: [],
        hint: 'Chưa cấu hình GEMINI_API_KEY để đọc ảnh menu trực tiếp. Hãy thêm GEMINI_API_KEY vào .env hoặc dán văn bản/CSV menu để bóc tách tức thì!',
    };
}

module.exports = { parseMenuUniversal, parseMenuFromTextLocal, chuanHoaDanhSachMon };
