import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeSessionStorage } from './services/database.ts'

async function bootstrap() {
  const storage = await initializeSessionStorage()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App
        initialSessions={storage.sessions}
        initialStorageWarning={storage.warning}
      />
    </StrictMode>,
  )
}

void bootstrap()
