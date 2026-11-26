export function calcCartItemUnitPrice(item) {
  const basePrice = Number(item?.donGiaTuyChinh ?? item?.donGia ?? 0)
  const modCost = Number(item?.giaModifiers || 0)
  const toppingCost = (item?.toppings || []).reduce(
    (sum, t) => sum + Number(t?.donGia || 0) * Number(t?.soLuongMoiLy ?? t?.soLuong ?? 1),
    0
  )
  return basePrice + modCost + toppingCost
}

export function calcCartTotal(cart = []) {
  return (Array.isArray(cart) ? cart : []).reduce(
    (sum, item) => sum + calcCartItemUnitPrice(item) * Math.max(1, Number(item?.soLuong || 1)),
    0
  )
}

function mapOrderModifiers(modifiers = []) {
  return (Array.isArray(modifiers) ? modifiers : []).map((m) => ({
    groupId: m.groupId,
    optionId: m.optionId,
    qty: Number(m.qty || 1),
  }))
}

function mapOrderToppings(toppings = []) {
  return (Array.isArray(toppings) ? toppings : []).map((t) => ({
    maTopping: t.maTopping,
    soLuongMoiLy: Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
    soLuong: Number(t.soLuongMoiLy ?? t.soLuong ?? 1),
  }))
}

function mapRegularOrderLine(item, overrideQty = null) {
  const rawPrice =
    item?.donGiaTuyChinh !== undefined && item?.donGiaTuyChinh !== null
      ? Number(item.donGiaTuyChinh)
      : item?.donGia !== undefined && item?.donGia !== null
        ? Number(item.donGia)
        : undefined
  const weightGram =
    item?.trongLuongGram !== undefined && item?.trongLuongGram !== null && Number(item.trongLuongGram) > 0
      ? Number(item.trongLuongGram)
      : undefined
  const customName =
    item?.tenMonTuyChinh && String(item.tenMonTuyChinh).trim()
      ? String(item.tenMonTuyChinh).trim()
      : undefined

  return {
    maMon: item.maMon,
    kichThuoc: item.kichThuoc,
    soLuong: Number(overrideQty !== null ? overrideQty : item.soLuong),
    ...(rawPrice !== undefined && Number.isFinite(rawPrice) ? { donGia: rawPrice } : {}),
    ...(weightGram !== undefined ? { trongLuongGram: weightGram } : {}),
    ...(customName !== undefined ? { tenMonTuyChinh: customName } : {}),
    ghiChu: item.ghiChu || null,
    isTakeaway: Boolean(item.isTakeaway),
    courseNo: Number(item.courseNo || 1),
    fireStatus: item.fireStatus === 'HELD' ? 'HELD' : 'FIRED',
    modifiers: mapOrderModifiers(item.modifiers),
    toppings: mapOrderToppings(item.toppings),
  }
}

export function buildOrderPayloadFromCart({
  selectedTable = null,
  activeInvoice = null,
  customer = null,
  cart = [],
  soTheRung = '',
  orderType = 'MANG_DI',
  tenKhachVangLai = '',
} = {}) {
  const cleanBuzzer = String(soTheRung || '').trim()
  const danhSachMon = []
  const comboGroups = new Map()

  for (const item of Array.isArray(cart) ? cart : []) {
    if (!item?.maMon) continue
    if (item.maCombo) {
      const groupKey = item.comboInstanceId || `CMB:${item.maCombo}`
      if (!comboGroups.has(groupKey)) comboGroups.set(groupKey, [])
      comboGroups.get(groupKey).push(item)
    } else {
      danhSachMon.push(mapRegularOrderLine(item))
    }
  }

  const combos = []
  for (const groupItems of comboGroups.values()) {
    if (groupItems.length === 0) continue
    const comboQty = Math.max(
      1,
      Math.min(...groupItems.map((it) => Math.max(1, Math.floor(Number(it.soLuong || 1)))))
    )
    const first = groupItems[0]
    combos.push({
      maCombo: first.maCombo,
      soLuong: comboQty,
      isTakeaway: groupItems.every((it) => Boolean(it.isTakeaway)),
      courseNo: Number(first.courseNo || 1),
      fireStatus: first.fireStatus === 'HELD' ? 'HELD' : 'FIRED',
      selections: groupItems.map((it) => ({
        ...(it.comboSlotId ? { slotId: it.comboSlotId } : {}),
        maMon: it.maMon,
        kichThuoc: it.kichThuoc,
        ghiChu: it.ghiChu || null,
        isTakeaway: Boolean(it.isTakeaway),
        courseNo: Number(it.courseNo || 1),
        fireStatus: it.fireStatus === 'HELD' ? 'HELD' : 'FIRED',
        modifiers: mapOrderModifiers(it.modifiers),
        toppings: mapOrderToppings(it.toppings),
      })),
    })

    for (const it of groupItems) {
      const extraQty = Math.floor(Number(it.soLuong || 1)) - comboQty
      if (extraQty > 0) {
        danhSachMon.push(mapRegularOrderLine(it, extraQty))
      }
    }
  }

  return {
    maBan: selectedTable?.maBan || null,
    maHoaDon: !selectedTable && activeInvoice ? activeInvoice.maHoaDon : null,
    maKH: customer?.maKH || null,
    loaiDonHang: selectedTable ? 'TAI_QUAN' : orderType || 'MANG_DI',
    ...(tenKhachVangLai?.trim() ? { tenKhachVangLai: tenKhachVangLai.trim() } : {}),
    ...(cleanBuzzer ? { soTheRung: cleanBuzzer } : {}),
    ...(activeInvoice?.version ? { expectedVersion: activeInvoice.version } : {}),
    danhSachMon,
    ...(combos.length > 0 ? { combos } : {}),
  }
}

export function buildHoldOrderPayloadFromCart({
  selectedTable = null,
  customer = null,
  cart = [],
  orderType = 'MANG_DI',
  tenKhachVangLai = '',
} = {}) {
  const danhSachMon = (Array.isArray(cart) ? cart : []).map((item) => {
    const unitPrice = Number(item?.donGiaTuyChinh ?? item?.donGia ?? 0)
    const modCost = Number(item?.giaModifiers || 0)
    const qty = Math.max(1, Number(item?.soLuong || 1))
    const weightGram =
      item?.trongLuongGram !== undefined && item?.trongLuongGram !== null && Number(item.trongLuongGram) > 0
        ? Number(item.trongLuongGram)
        : undefined
    const customName =
      item?.tenMonTuyChinh && String(item.tenMonTuyChinh).trim()
        ? String(item.tenMonTuyChinh).trim()
        : undefined

    return {
      maMon: item.maMon,
      tenMon: item.tenMon || item.maMon,
      kichThuoc: item.kichThuoc || 'M',
      soLuong: qty,
      donGia: Number.isFinite(unitPrice) ? unitPrice : 0,
      giaModifiers: Number.isFinite(modCost) ? modCost : 0,
      modifiers: (Array.isArray(item.modifiers) ? item.modifiers : []).map((m) => ({
        groupId: m.groupId,
        tenGroup: m.tenGroup,
        optionId: m.optionId,
        tenOption: m.tenOption,
        tenInNgan: m.tenInNgan || m.tenOption,
        qty: Number(m.qty || 1),
        freeQty: Number(m.freeQty || 0),
        giaCongThem: Number(m.giaCongThem || 0),
      })),
      ghiChu: item.ghiChu || null,
      isTakeaway: Boolean(item.isTakeaway),
      courseNo: Number(item.courseNo || 1),
      fireStatus: item.fireStatus === 'HELD' ? 'HELD' : 'FIRED',
      ...(weightGram !== undefined ? { trongLuongGram: weightGram } : {}),
      ...(customName !== undefined ? { tenMonTuyChinh: customName } : {}),
      ...(item.maCombo
        ? {
            maCombo: item.maCombo,
            tenComboSnapshot: item.tenComboSnapshot || null,
            comboInstanceId: item.comboInstanceId || null,
            comboSlotId: item.comboSlotId || null,
          }
        : {}),
      toppings: (Array.isArray(item.toppings) ? item.toppings : []).map((t) => {
        const perCup = Math.max(1, Number(t.soLuongMoiLy ?? t.soLuong ?? 1))
        return {
          maTopping: t.maTopping,
          tenTopping: t.tenTopping || t.maTopping,
          donGia: Number(t.donGia || 0),
          soLuongMoiLy: perCup,
          soLuong: perCup,
        }
      }),
    }
  })

  return {
    label: tenKhachVangLai?.trim() || customer?.tenKH || selectedTable?.tenBan || null,
    maKH: customer?.maKH || null,
    loaiDonHang: selectedTable ? 'TAI_QUAN' : orderType || 'MANG_DI',
    tongTamTinh: calcCartTotal(cart),
    danhSachMon,
  }
}

export function buildCreateOrderBody({
  maBan,
  maHoaDon = null,
  maKH,
  danhSachMon,
  combos = [],
  soTheRung = null,
  loaiDonHang = null,
  tenKhachVangLai = null,
  diaChiGiao = null,
  soKhach = 1,
  expectedVersion = null,
  choThanhToanTruoc,
  phuongThucDuKien = null,
} = {}) {
  return {
    maBan,
    maHoaDon,
    maKH,
    danhSachMon,
    ...(Array.isArray(combos) && combos.length > 0 ? { combos } : {}),
    ...(soTheRung ? { soTheRung } : {}),
    ...(loaiDonHang ? { loaiDonHang } : {}),
    ...(tenKhachVangLai ? { tenKhachVangLai } : {}),
    ...(diaChiGiao ? { diaChiGiao } : {}),
    ...(soKhach ? { soKhach } : {}),
    ...(expectedVersion !== null && expectedVersion !== undefined ? { expectedVersion } : {}),
    ...(choThanhToanTruoc !== undefined ? { choThanhToanTruoc: Boolean(choThanhToanTruoc) } : {}),
    ...(phuongThucDuKien ? { phuongThucDuKien } : {}),
  }
}
