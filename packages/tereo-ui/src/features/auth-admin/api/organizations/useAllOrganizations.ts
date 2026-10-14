import fetchAllPages from "@/utils/fetchAllPages";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

interface OrganizationOption {
  id: string;
  name: string;
}

/** Every organization, for pickers. */
const useAllOrganizations = () => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["allOrganizations"],
    queryFn: () =>
      fetchAllPages<OrganizationOption>(axios, "/v1/admin/organizations", {
        sort: "name",
        sortDir: "asc",
      }),
  });
};

export default useAllOrganizations;
