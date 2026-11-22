// Kiểm tra cờ tính năng theo gói cước (mặc định true nếu tài khoản cũ chưa có featureFlags để đảm bảo tương thích ngược)
export function hasFeatureFlag(user, featureKey) {
  if (!user || !user.featureFlags || typeof user.featureFlags !== 'object') return true
  if (typeof user.featureFlags[featureKey] === 'boolean') {
    return user.featureFlags[featureKey]
  }
  return true
}
