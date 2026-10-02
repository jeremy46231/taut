/**
 * @param {Response} response
 * @returns {Promise<import('./rpc').SerialFetchResponse>}
 */
export async function serializeResponse(response) {
  /** @type {Record<string, string>} */
  const headers = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: new Uint8Array(await response.arrayBuffer()),
  }
}
