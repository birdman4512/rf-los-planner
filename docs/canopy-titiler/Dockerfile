FROM ghcr.io/osgeo/gdal:ubuntu-small-latest

# The GDAL image gives rasterio/GDAL basics, but titiler's Python deps may need
# a compiler on this base image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-pip python3-dev build-essential \
 && pip install --no-cache-dir --break-system-packages titiler.application uvicorn \
 && apt-get purge -y build-essential python3-dev && apt-get autoremove -y \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

EXPOSE 8000
CMD ["uvicorn","titiler.application.main:app","--host","0.0.0.0","--port","8000"]
