import { newClientSecretValue } from "../../utils/secretRules.js";

export function runGenerateSecretCli(): void {
  console.log(newClientSecretValue());
}
