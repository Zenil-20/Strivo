import { Link, NavLink, Route, Routes } from 'react-router';
import logoUrl from './assets/logo.svg';
import LibraryPage from './pages/LibraryPage.jsx';
import UploadPage from './pages/UploadPage.jsx';
import WatchPage from './pages/WatchPage.jsx';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="logo" data-tile>
          <img src={logoUrl} alt="" className="logo-icon" aria-hidden="true" />
          <span className="logo-text">Strivo</span>
          <span className="logo-badge">TV</span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')} data-tile>
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
            <span>Library</span>
          </NavLink>
          <NavLink to="/upload" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')} data-tile>
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Upload</span>
          </NavLink>
        </nav>
      </header>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/watch/:shareId" element={<WatchPage />} />
          <Route
            path="*"
            element={
              <div className="state-card">
                <h1 className="state-title">Page not found</h1>
                <p className="state-description">The requested page doesn't exist.</p>
                <Link to="/" className="btn-primary">Go to Library</Link>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

