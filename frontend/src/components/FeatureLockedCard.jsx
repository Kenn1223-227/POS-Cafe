import { Link } from 'react-router-dom'

export default function FeatureLockedCard({
  title,
  description,
  requiredPlan = 'PRO',
  currentPlan = 'STARTER',
  compact = false,
}) {
  if (compact) {
    return (
      <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="space-y-0.5">
          <p className="font-extrabold text-amber-950">
            🔒 {title} (Dành cho gói {requiredPlan})
          </p>
          <p className="text-amber-800">{description}</p>
        </div>
        <Link
          to="/admin/saas"
          className="px-3.5 py-2 rounded-lg bg-amber-700 hover:bg-amber-800 text-white font-extrabold shrink-0"
        >
          💎 Nâng cấp lên {requiredPlan}
        </Link>
      </div>
    )
  }

  return (
    <div className="bg-gradient-to-br from-amber-50 to-orange-50 border-2 border-amber-200 rounded-2xl p-6 text-center space-y-3">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-amber-100 text-2xl">
        🔒
      </div>
      <div className="space-y-1 max-w-lg mx-auto">
        <p className="text-[11px] font-extrabold uppercase tracking-wider text-amber-700">
          Tính năng nâng cao • Gói hiện tại: {currentPlan}
        </p>
        <h3 className="text-base font-black text-gray-900">{title}</h3>
        <p className="text-xs text-gray-600">{description}</p>
      </div>
      <div>
        <Link
          to="/admin/saas"
          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-extrabold text-xs shadow"
        >
          💎 Nâng cấp lên gói {requiredPlan} để mở khóa
        </Link>
      </div>
    </div>
  )
}
