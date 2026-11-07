import useUploadBrandingImage from "../../api/branding/useUploadBrandingImage";
import { brandingErrorMessage } from "../../api/branding/brandingErrors";
import { Button } from "@kosmeo-ui/react";
import { useId, useState } from "react";
import type {
  BrandingImage,
  BrandingImageSlot,
} from "../../api/branding/types";

const ACCEPT: Record<BrandingImageSlot, string> = {
  logo: "image/png,image/jpeg,image/webp,image/svg+xml",
  logoDark: "image/png,image/jpeg,image/webp,image/svg+xml",
  favicon: "image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon",
  background: "image/png,image/jpeg,image/webp",
};

interface ImageFieldProps {
  slot: BrandingImageSlot;
  label: string;
  value: BrandingImage | null;
  onChange: (value: BrandingImage | null) => void;
  readOnly: boolean;
}

export const ImageField = ({
  slot,
  label,
  value,
  onChange,
  readOnly,
}: ImageFieldProps) => {
  const id = useId();
  const upload = useUploadBrandingImage();
  const [error, setError] = useState<string | null>(null);

  const pick = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    upload.mutate(
      { slot, file },
      {
        onSuccess: onChange,
        onError: (e) =>
          setError(brandingErrorMessage(e, "Could not upload the image")),
      }
    );
  };

  return (
    <div className="t-image-field">
      <label htmlFor={id}>{label}</label>
      {value && <img src={value.url} alt={`${label} preview`} />}
      {!readOnly && (
        <input
          id={id}
          type="file"
          accept={ACCEPT[slot]}
          disabled={upload.isPending}
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      )}
      {!readOnly && value && (
        <Button variant="secondary" onClick={() => onChange(null)}>
          Remove
        </Button>
      )}
      {error && (
        <p role="alert" className="t-field-error">
          {error}
        </p>
      )}
    </div>
  );
};
