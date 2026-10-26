# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below. The ported parts were rewritten
in JavaScript; they are changed from the original (another language, another
structure, only what this integration needs). None of the original code is
copied as is.

## pytouchline_extended

- Project: [brondum/pytouchline](https://github.com/brondum/pytouchline)
  (`pytouchline_extended` on PyPI), version 1.1.2, "A Python interface for
  controlling a Roth Touchline heat pump controller", by brondum, extended
  from `pytouchline` by abondoe; the library of the Home Assistant
  `touchline` integration.
- What is ported (in `src/constants.js`, `src/touchline/xml.js`,
  `src/touchline/model.js` and `src/touchline/client.js`): the two CGI
  scripts of the controller (`POST /cgi-bin/ILRReadValues.cgi` with an XML
  body of item names, `GET /cgi-bin/writeVal.cgi?G<i>.<parameter>=<value>`),
  the shape of the read request (`body`, `version`, `client`, `client_ver`,
  `file_name`, `item_list_size`, `item_list`, `i`, `n`) and of the answer
  (`item_list`, `i`, `n`, `v`), the item `totalNumberOfDevices`, the
  parameters of a device (`name`, `SollTempMaxVal`, `SollTempMinVal`,
  `WeekProg`, `OPMode`, `SollTemp`, `RaumTemp`, `kurzID`, `ownerKurzID`),
  temperatures in hundredths of °C, the echo of a written value as its
  confirmation.
- Changes: rewritten in JavaScript for a Gladys external integration; the
  read request identifies this integration (`client`), not the Roth
  software; `CD.upass` (the password of the controller) is never asked; the
  answers are read linearly with a size and item limit, as untrusted data,
  without an XML parser; values are checked (plain integers, plausible
  temperatures); the setpoint limits of a device (`SollTempMaxVal`,
  `SollTempMinVal`) and its name are read but never written; writes are
  bounded by the limits of the device and a ceiling, spaced, behind options,
  and sent as clean integers; no Home Assistant code.
- Licence: MIT. Full text below.

```
MIT License

Copyright (c) 2017 abondoe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
