/**
 * SRP login (USER_SRP_AUTH).
 *
 * The backoffice app client enables ALLOW_USER_SRP_AUTH but not
 * ALLOW_USER_PASSWORD_AUTH, and this role cannot call AdminInitiateAuth — SRP is
 * the only flow left, and it is exactly what the backoffice web app uses. It
 * needs no AWS credentials: the password never leaves as plaintext, the client
 * proves knowledge of it through the SRP exchange.
 */

import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

/**
 * @returns {Promise<{IdToken:string, AccessToken:string, RefreshToken:string}>}
 */
export function srpLogin({ userPoolId, clientId, username, password }) {
  const pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });
  const user = new CognitoUser({ Username: username, Pool: pool });
  const auth = new AuthenticationDetails({ Username: username, Password: password });

  return new Promise((resolve, reject) => {
    user.authenticateUser(auth, {
      onSuccess: (session) =>
        resolve({
          IdToken: session.getIdToken().getJwtToken(),
          AccessToken: session.getAccessToken().getJwtToken(),
          RefreshToken: session.getRefreshToken().getToken(),
        }),
      onFailure: (err) => reject(new Error(err.message || String(err))),
      newPasswordRequired: () =>
        reject(
          new Error(
            'Cognito pide cambiar la contraseña (NEW_PASSWORD_REQUIRED). Entra una vez al ' +
              'backoffice, cámbiala, y vuelve a intentar aquí.',
          ),
        ),
      mfaRequired: () =>
        reject(new Error('Este usuario tiene MFA. Pega el idToken a mano desde el backoffice.')),
      totpRequired: () =>
        reject(new Error('Este usuario tiene TOTP. Pega el idToken a mano desde el backoffice.')),
    });
  });
}
