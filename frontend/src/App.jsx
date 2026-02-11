import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Booth from './pages/Booth.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/booth/:roomId" element={<Booth />} />
    </Routes>
  )
}
