import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import RegisterPage from './views/RegisterPage'
import { ToastProvider } from './components/ui'

// /r/<token> = public tenant registration form (no login). Everything else = the app.
const reg = window.location.pathname.match(/^\/r\/([A-Za-z0-9]+)\/?$/)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>{reg ? <RegisterPage token={reg[1]} /> : <App />}</ToastProvider>
  </React.StrictMode>,
)
