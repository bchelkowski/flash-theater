sub init()
  m.top.functionName = "ft_runRequest"
  m.top.resolvedOptions = { method: "GET", url: "https://jsonplaceholder.typicode.com/posts", headers: { }, query: { }, body: invalid, cache: { "disabled": false, "ttlSeconds": invalid }, buildSucceeded: true, buildErrorMessage: "" }
end sub

sub ft_runRequest()
  options = m.top.resolvedOptions
  response = ft_httpFetch(options)
  ft_parseSucceeded = true
  ft_parseErrorMessage = ""
  if response.isSuccess then
    try
      m.top.result = private_parseResponse(response)
    catch ft_e
      ft_parseSucceeded = false
      ft_parseErrorMessage = ft_e.message
      m.top.error = { message: "parseResponse threw: " + ft_e.message, parseFailed: true, httpStatusCode: response.httpStatusCode, raw: response }
    end try
  else
    m.top.error = response
  end if
  response.parseSucceeded = ft_parseSucceeded
  response.parseErrorMessage = ft_parseErrorMessage
  m.top.rawResponse = response
end sub

function private_parseResponse(response as object) as object
  return { items: response?.data }
end function

sub ft_unmount()
end sub
