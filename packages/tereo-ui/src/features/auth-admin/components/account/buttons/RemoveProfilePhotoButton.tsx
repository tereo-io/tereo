import useDeletePhoto from "@/features/auth-admin/api/account/useDeletePhoto";
import { Button } from "@kosmeo-ui/react";

const RemoveProfilePhotoButton = () => {
  const deletePhotoMutation = useDeletePhoto();

  return (
    <Button
      variant="danger"
      size="sm"
      onClick={() => deletePhotoMutation.mutate()}
      isLoading={deletePhotoMutation.isPending}
    >
      Remove
    </Button>
  );
};

export default RemoveProfilePhotoButton;
