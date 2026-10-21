import { faUser, faSignOutAlt } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useAvatarPhoto } from "@/features/auth-admin";
import { useEffect, useRef, useState } from "react";
import { LoadingOverlay } from "@kosmeo-ui/react";
import { useAuth, useLogout } from "@/lib/auth";
import { OrgSwitcher } from "@/features/auth";
import { Link } from "react-router-dom";
import "./UserMenu.css";

export const UserMenu = () => {
  const { user, organizations } = useAuth();
  const photoUrl = useAvatarPhoto();
  const logout = useLogout();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        e.preventDefault();
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleSignOut = () => {
    setIsOpen(false);
    setIsLoggingOut(true);
    logout.mutate();
  };

  return (
    <div ref={menuRef} className="t-user-menu-container">
      <LoadingOverlay show={isLoggingOut} message="Signing out..." />
      <button
        className="t-avatar-btn"
        aria-label="User menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        onMouseDown={(e) => e.preventDefault()}
      >
        {photoUrl ? (
          <img src={photoUrl} alt="Avatar" className="t-avatar-img" />
        ) : (
          <FontAwesomeIcon icon={faUser} className="t-avatar-icon" />
        )}
      </button>

      <div className={`t-user-menu ${isOpen ? "open" : ""}`}>
        <div className="t-user-menu-header">
          {user?.name && <div className="t-user-menu-name">{user.name}</div>}
          <div className="t-user-menu-email">{user?.email}</div>
        </div>

        {organizations.length > 1 && (
          <div className="t-user-menu-section">
            <OrgSwitcher label="Organization" />
          </div>
        )}

        <Link
          to="/account"
          className="t-user-menu-item"
          onClick={() => setIsOpen(false)}
        >
          <FontAwesomeIcon icon={faUser} />
          <span>My Account</span>
        </Link>

        <button className="t-user-menu-item" onClick={handleSignOut}>
          <FontAwesomeIcon icon={faSignOutAlt} />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
};
