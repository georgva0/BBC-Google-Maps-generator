window.renderLocator = function(latitude, longitude) {
    const container = d3.select("#locator-container");
    container.selectAll("*").remove();

    const width = 116;
    const height = 116;
    const projection = d3.geoSatellite()
        .distance(10000000)
        .scale(57)
        .translate([width / 2, height / 2])
        .precision(0.1)
        .rotate([-longitude, -latitude + latitude / 2.5]);
    const path = d3.geoPath().projection(projection);
    const svg = container.append("svg")
        .attr("id", "locator-svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("role", "img")
        .attr("aria-label", `Globe locator centered at ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`)
        .attr("xmlns", "http://www.w3.org/2000/svg");
    const countries = topojson.feature(mapWorldTopology, mapWorldTopology.objects.countries).features;

    svg.append("path")
        .datum({ type: "Sphere" })
        .attr("d", path)
        .attr("fill", "#b2cdce");
    svg.selectAll("path.land")
        .data(countries)
        .enter()
        .append("path")
        .attr("class", "land")
        .attr("d", path)
        .attr("fill", "#fff")
        .attr("stroke", "#849795")
        .attr("stroke-width", 0.35);
    svg.append("path")
        .datum({ type: "Sphere" })
        .attr("d", path)
        .attr("fill", "none")
        .attr("stroke", "#7c7c7c")
        .attr("stroke-width", 1);

    const point = projection([longitude, latitude]);
    if (point) {
        svg.append("circle")
            .attr("cx", point[0])
            .attr("cy", point[1])
            .attr("r", 3)
            .attr("fill", "#17231e");
    }
};