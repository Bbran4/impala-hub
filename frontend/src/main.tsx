import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ReportPrint,{printTicket} from './biReportPrint'
import './style.css'
import './facebook.css'
import './chat.css'

// Report emails: headless Chrome opens /#report-print=<ticket> to draw one sheet
const ticket = printTicket(window.location.hash)
createRoot(document.getElementById('root')!).render(<React.StrictMode>{ticket ? <ReportPrint ticket={ticket} /> : <App />}</React.StrictMode>)
