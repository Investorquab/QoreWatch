/** URLs of QoreWatch's own pages (served by the bot's HTTP server behind PUBLIC_URL). Codes ride in the fragment, so they never reach server logs. */
export const pages = (publicUrl: string) => ({
  link: (code: string) => `${publicUrl}/link#${code}`,
  attest: (code: string) => `${publicUrl}/attest#${code}`,
  tx: (hash: string) => `${publicUrl}/tx/${hash}`,
  check: (address: string) => `${publicUrl}/check/${address}`,
  fixWindow: (address: string) => `${publicUrl}/fix/window#${address}`,
  fixAuthz: (granter: string, grantee: string, msg: string) => `${publicUrl}/fix/authz#${new URLSearchParams({ granter, grantee, msg })}`,
  fixFeegrant: (granter: string, grantee: string) => `${publicUrl}/fix/feegrant#${new URLSearchParams({ granter, grantee })}`,
  fixApproval: (owner: string, token: string, spender: string) => `${publicUrl}/fix/approval#${new URLSearchParams({ owner, token, spender })}`,
  fixKey: (address: string) => `${publicUrl}/fix/key#${address}`,
  fixSession: (address: string) => `${publicUrl}/fix/session#${address}`,
  home: () => publicUrl,
});

/** The explorer's address and transaction pages. It opens on Mainnet; the user picks Testnet at the top. */
export const explorer = (base: string) => ({
  tx: (hash: string) => `${base}/tx/${hash}`,
  address: (addr: string) => `${base}/address/${addr}`,
  block: (h: number) => `${base}/block/${h}`,
});
