import { BrandingEditor } from "./BrandingEditor";
import { useParams } from "react-router-dom";

export const DefaultBrandingPage = () => (
  <BrandingEditor target={{ kind: "default" }} />
);

export const ClientBrandingPage = () => {
  const { id } = useParams<{ id: string }>();
  return <BrandingEditor key={id} target={{ kind: "client", id: id ?? "" }} />;
};
