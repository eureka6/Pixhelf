variable "IMAGE" {
  default = "eureka6688/pixhelf"
}

variable "VERSION" {
  default = "dev"
}

variable "PLATFORMS" {
  default = "linux/amd64"
}

group "default" {
  targets = ["image"]
}

target "image" {
  context = "."
  dockerfile = "Dockerfile"
  target = "runtime-alpine"
  platforms = split(",", PLATFORMS)
  tags = [
    "${IMAGE}:${VERSION}",
    "${IMAGE}:${VERSION}-alpine",
    "${IMAGE}:${VERSION}-musl",
    "${IMAGE}:latest",
  ]
}
