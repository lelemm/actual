import { ActualPlugin, Button } from "@actual-app/plugins-core";

type ClickMeButtonProps = {
    context: Parameters<ActualPlugin['activate']>[0];
  };

export function ClickMeButton({ context }: ClickMeButtonProps) {
    return <Button
    onPress={() => {
      context.navigate("/custom/test");
    }}
    variant="primary"
  >
    Click me
  </Button>;
}