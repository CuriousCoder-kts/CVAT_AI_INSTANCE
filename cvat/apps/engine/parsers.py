# Copyright (C) 2021-2022 Intel Corporation
#
# SPDX-License-Identifier: MIT

from rest_framework.parsers import BaseParser, JSONParser


class TusUploadParser(BaseParser):
    media_type = "application/offset+octet-stream"

    def parse(self, stream, media_type=None, parser_context=None):
        return {}


class CVATJsonParser(JSONParser):
    media_type = "application/vnd.cvat+json"
