import { Button, SectionHeader } from "@kosmeo-ui/react";
import { ReactNode, isValidElement } from "react";

interface PageHeaderAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  badges?: ReactNode;
  actions?: PageHeaderAction[] | ReactNode[];
}

const isActionObject = (
  action: PageHeaderAction | ReactNode
): action is PageHeaderAction => {
  return (
    action !== null &&
    typeof action === "object" &&
    !isValidElement(action) &&
    "label" in action &&
    "onClick" in action
  );
};

export const PageHeader = ({
  title,
  subtitle,
  badges,
  actions,
}: PageHeaderProps) => {
  const renderedActions = actions?.length
    ? actions.map((action, index) =>
        isActionObject(action) ? (
          <Button
            key={index}
            variant={action.variant || "secondary"}
            onClick={action.onClick}
            disabled={action.disabled}
            fullWidth={false}
          >
            {action.label}
          </Button>
        ) : (
          <span key={index}>{action}</span>
        )
      )
    : undefined;

  return (
    <SectionHeader
      as="h1"
      title={title}
      subtitle={subtitle}
      badges={badges}
      actions={renderedActions}
    />
  );
};
