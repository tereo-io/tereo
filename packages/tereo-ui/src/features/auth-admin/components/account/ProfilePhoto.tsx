import ProfilePhotoUploadButton from "./buttons/ProfilePhotoUploadButton";
import RemoveProfilePhotoButton from "./buttons/RemoveProfilePhotoButton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUser } from "@fortawesome/free-solid-svg-icons";
import { Card } from "@kosmeo-ui/react";
import "./styles.css";

interface ProfilePhotoProps {
  photoUrl: string | null;
}

const ProfilePhoto = ({ photoUrl }: ProfilePhotoProps) => {
  return (
    <Card>
      <div className="t-profile-photo-container">
        <div className="t-profile-photo-wrapper">
          {photoUrl ? (
            <img
              src={photoUrl}
              alt="Profile"
              className="t-profile-photo-image"
            />
          ) : (
            <div className="t-profile-photo-placeholder">
              <FontAwesomeIcon icon={faUser} size="3x" />
            </div>
          )}
          <ProfilePhotoUploadButton photoUrl={photoUrl} variant="icon" />
        </div>
        <div className="t-profile-photo-actions">
          <ProfilePhotoUploadButton photoUrl={photoUrl} />
          {photoUrl && <RemoveProfilePhotoButton />}
        </div>
      </div>
    </Card>
  );
};

export default ProfilePhoto;
