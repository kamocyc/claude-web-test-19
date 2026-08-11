/**
 * Vite の `?worker&url` インポート。
 * 指定したモジュールを独立したチャンクへバンドルし、その URL を返す。
 * AudioWorklet は素の JavaScript しか読めないため、TypeScript で書いた
 * ワークレットはこの経路でしか渡せない。
 */
declare module '*?worker&url' {
  const url: string;
  export default url;
}
