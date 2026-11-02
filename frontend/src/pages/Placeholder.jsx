import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { ROLE_LABEL } from '../constants/roles'

export default function Placeholder({ title }) {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-stone-100 p-4">
      <div className="card max-w-md w-full p-8 text-center space-y-4">
        <div className="text-5xl">☕</div>
        <h1 className="text-2xl font-bold text-stone-800">{title}</h1>
        <p className="text-stone-600">
          Xin chào <b>{user?.tenNV}</b> ({ROLE_LABEL[user?.vaiTro] || `Vai trò ${user?.vaiTro}`})
        </p>
        <button
          onClick={handleLogout}
          className="btn bg-red-600 hover:bg-red-700 text-white w-full min-h-14 text-base"
        >
          Đăng xuất
        </button>
      </div>
    </div>
  )
}