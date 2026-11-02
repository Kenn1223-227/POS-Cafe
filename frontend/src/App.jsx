import { Toaster } from 'react-hot-toast'
import AppRouter from './routes/AppRouter'

export default function App() {
  return (
    <>
      <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
      <AppRouter />
    </>
  )
}