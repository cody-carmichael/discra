declare module "react-native-signature-canvas" {
  import * as React from "react";

  type SignatureScreenProps = {
    onOK?: (signature: string) => void;
    onEmpty?: () => void;
    onClear?: () => void;
    autoClear?: boolean;
    clearText?: string;
    confirmText?: string;
    descriptionText?: string;
    webStyle?: string;
  };

  const SignatureScreen: React.ComponentType<SignatureScreenProps>;
  export default SignatureScreen;
}
