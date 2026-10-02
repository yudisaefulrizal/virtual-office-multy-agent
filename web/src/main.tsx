import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Tanpa StrictMode: mount ganda di development membuat label <Html> drei
// pertama di scene hilang (portal dibuat lalu dilepas sebelum frame pertama).
createRoot(document.getElementById('root')!).render(<App />);
