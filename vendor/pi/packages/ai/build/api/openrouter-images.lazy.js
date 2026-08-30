export const openrouterImagesApi = () => ({
    generateImages: async (model, context, options) => (await import("./openrouter-images.js")).generateImages(model, context, options),
});
