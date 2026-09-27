import { Link, NavLink, Route, Routes } from 'react-router';
import LibraryPage from './pages/LibraryPage.jsx';
import UploadPage from './pages/UploadPage.jsx';
import WatchPage from './pages/WatchPage.jsx';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="logo">Strivo</Link>
        <nav className="nav">
          <NavLink to="/" end>Library</NavLink>
          <NavLink to="/upload">Upload</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/watch/:shareId" element={<WatchPage />} />
          <Route
            path="*"
            element={
              <div className="card">
                <h1>Page not found</h1>
                <Link to="/">Go to the library</Link>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
